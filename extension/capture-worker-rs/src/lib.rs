use serde_json::{json, Map, Value};
use std::{mem, slice};

const MAX_SEARCH_DEPTH: usize = 12;

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn first_text<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> &'a str {
    values
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty())
        .unwrap_or("")
}

fn integer(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_i64().or_else(|| {
            number.as_f64().and_then(|value| {
                if value.is_finite() && value.fract() == 0.0 {
                    Some(value as i64)
                } else {
                    None
                }
            })
        }),
        Some(Value::String(value)) if !value.is_empty() => value.parse::<i64>().ok(),
        _ => None,
    }
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(value)) if !value.is_empty() => value.parse::<f64>().ok(),
        _ => None,
    }
}

fn member_id_from_urn(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    for marker in ["fsd_profile:", "fs_miniprofile:", "member:"] {
        if let Some(start) = lower.find(marker) {
            let rest = &value[start + marker.len()..];
            let end = rest.find([',', ')']).unwrap_or(rest.len());
            return rest[..end].to_string();
        }
    }
    String::new()
}

fn member_id_for(entity: &Value) -> String {
    for key in [
        "entityUrn",
        "trackingUrn",
        "memberUrn",
        "connectedMember",
        "*connectedMember",
    ] {
        if let Some(candidate) = text(entity, key) {
            let member_id = member_id_from_urn(candidate);
            if !member_id.is_empty() {
                return member_id;
            }
        }
    }
    first_text([
        text(entity, "memberId"),
        entity.get("member").and_then(|member| text(member, "id")),
        text(entity, "id"),
    ])
    .to_string()
}

fn normalized_member_external_id(member_id: &str) -> String {
    if member_id.is_empty() {
        return String::new();
    }
    let mut normalized = String::with_capacity(member_id.len() + 7);
    normalized.push_str("member_");
    let mut previous_replacement = false;
    for character in member_id.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            normalized.push(character);
            previous_replacement = false;
        } else if !previous_replacement {
            normalized.push('_');
            previous_replacement = true;
        }
        if normalized.len() >= 200 {
            break;
        }
    }
    normalized
}

fn vector_image(node: &Value, depth: usize) -> Option<&Value> {
    if depth > MAX_SEARCH_DEPTH {
        return None;
    }
    if let Value::Array(items) = node {
        return items
            .iter()
            .find_map(|value| vector_image(value, depth + 1));
    }
    let object = node.as_object()?;
    if object
        .get("artifacts")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
        && object.get("rootUrl").and_then(Value::as_str).is_some()
    {
        return Some(node);
    }
    if let Some(found) = object
        .get("vectorImage")
        .and_then(|value| vector_image(value, depth + 1))
    {
        return Some(found);
    }
    object
        .values()
        .filter(|value| value.is_object() || value.is_array())
        .find_map(|value| vector_image(value, depth + 1))
}

fn cdn_url(node: &Value, depth: usize) -> Option<&str> {
    if depth > MAX_SEARCH_DEPTH {
        return None;
    }
    if let Some(value) = node.as_str() {
        let safe = value.starts_with("https://")
            && value.contains("licdn.com/")
            && !value.chars().any(|character| {
                character.is_whitespace() || matches!(character, '"' | '\'' | '<' | '>')
            });
        return safe.then_some(value);
    }
    match node {
        Value::Object(object) => object.values().find_map(|value| cdn_url(value, depth + 1)),
        Value::Array(items) => items.iter().find_map(|value| cdn_url(value, depth + 1)),
        _ => None,
    }
}

fn photo_url(profile_picture: Option<&Value>) -> String {
    let Some(profile_picture) = profile_picture else {
        return String::new();
    };
    if let Some(value) = profile_picture.as_str() {
        if value.starts_with("http") {
            return value.to_string();
        }
    }
    if let Some(image) = vector_image(profile_picture, 0) {
        let artifacts = image.get("artifacts").and_then(Value::as_array).unwrap();
        let largest = artifacts.iter().max_by(|left, right| {
            number(left.get("width"))
                .unwrap_or(0.0)
                .total_cmp(&number(right.get("width")).unwrap_or(0.0))
        });
        let segment = largest
            .and_then(|artifact| text(artifact, "fileIdentifyingUrlPathSegment"))
            .unwrap_or("");
        if segment.starts_with("http://") || segment.starts_with("https://") {
            return segment.to_string();
        }
        if !segment.is_empty() {
            if let Some(root) = text(image, "rootUrl") {
                if !root.is_empty() {
                    return format!("{root}{segment}");
                }
            }
        }
    }
    cdn_url(profile_picture, 0).unwrap_or("").to_string()
}

fn first_image_url<'a>(candidates: impl IntoIterator<Item = Option<&'a Value>>) -> String {
    for candidate in candidates.into_iter().flatten() {
        let url = photo_url(Some(candidate));
        if !url.is_empty() {
            return url;
        }
    }
    String::new()
}

// The Connection wrapper (not the resolved profile) carries the epoch-ms
// timestamp of when the two members connected.
fn connected_at(element: &Value) -> Value {
    integer(element.get("createdAt"))
        .filter(|value| *value > 0)
        .map(Value::from)
        .unwrap_or(Value::Null)
}

fn parse_connection_element(element: &Value) -> Option<Value> {
    let member = element
        .get("connectedMemberResolutionResult")
        .or_else(|| element.get("connectedMember"))
        .unwrap_or(element);
    if member.is_string() {
        return None;
    }
    let profile = member
        .get("miniProfile")
        .or_else(|| member.get("profile"))
        .unwrap_or(member);
    let first_name = first_text([text(profile, "firstName"), text(member, "firstName")]);
    let last_name = first_text([text(profile, "lastName"), text(member, "lastName")]);
    let name = format!("{first_name} {last_name}").trim().to_string();
    if name.is_empty() {
        return None;
    }
    let public_id = first_text([
        text(profile, "publicIdentifier"),
        text(member, "publicIdentifier"),
    ]);
    let member_id = {
        let profile_id = member_id_for(profile);
        if profile_id.is_empty() {
            member_id_for(member)
        } else {
            profile_id
        }
    };
    let external_id = if public_id.is_empty() {
        normalized_member_external_id(&member_id)
    } else {
        public_id.to_string()
    };
    if external_id.is_empty() {
        return None;
    }
    let bio = first_text([text(profile, "headline"), text(member, "headline")]);
    let photo_url = first_image_url([
        profile.get("profilePicture"),
        profile.get("profilePictureDisplayImage"),
        profile.get("displayPhoto"),
    ]);
    let linkedin_url = if public_id.is_empty() {
        String::new()
    } else {
        format!("https://www.linkedin.com/in/{public_id}")
    };
    Some(json!({
        "name": name,
        "bio": bio,
        "linkedinUrl": linkedin_url,
        "externalId": external_id,
        "memberId": member_id,
        "photoUrl": photo_url
    }))
}

fn invalid_connection(element: &Value, index: usize, page_start: i64) -> Value {
    let urn = first_text([
        text(element, "entityUrn"),
        text(element, "connectedMember"),
        text(element, "*connectedMember"),
    ]);
    let element_member_id = member_id_for(element);
    let member_id = if element_member_id.is_empty() {
        member_id_from_urn(urn)
    } else {
        element_member_id
    };
    let fallback_external_id = format!("connection_offset_{}", page_start + index as i64);
    let normalized_external_id = normalized_member_external_id(&member_id);
    let external_id = if normalized_external_id.is_empty() {
        fallback_external_id
    } else {
        normalized_external_id
    };
    let resolution = element.get("connectedMemberResolutionResult");
    let first_name = first_text([
        text(element, "firstName"),
        resolution.and_then(|value| text(value, "firstName")),
    ]);
    let last_name = first_text([
        text(element, "lastName"),
        resolution.and_then(|value| text(value, "lastName")),
    ]);
    let joined_name = format!("{first_name} {last_name}").trim().to_string();
    let name = if joined_name.is_empty() {
        "LinkedIn member".to_string()
    } else {
        joined_name
    };
    json!({
        "name": name,
        "externalId": external_id,
        "memberId": member_id,
        "linkedinUrl": "",
        "bio": text(element, "headline").unwrap_or(""),
        "photoUrl": first_image_url([
            element.get("profilePicture"),
            resolution.and_then(|value| value.get("profilePicture")),
        ]),
        "_captureIncomplete": true,
        "_captureError": "LinkedIn did not expose a resolvable public profile for this connection",
        "_sourceOffset": page_start + index as i64,
        "_entityUrn": if urn.is_empty() { Value::Null } else { Value::String(urn.to_string()) }
    })
}

pub fn parse_connections_response(data: &Value) -> Value {
    let paging = data.get("paging").unwrap_or(&Value::Null);
    let page_start = integer(paging.get("start")).unwrap_or(0);
    let included = data
        .get("included")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let fallback_elements;
    let raw_elements = if let Some(elements) = data.get("elements").and_then(Value::as_array) {
        elements.as_slice()
    } else {
        fallback_elements = included
            .iter()
            .filter(|item| {
                item.as_object().is_some()
                    && (item.get("publicIdentifier").is_some() || item.get("entityUrn").is_some())
            })
            .cloned()
            .collect::<Vec<_>>();
        fallback_elements.as_slice()
    };

    let connections = raw_elements
        .iter()
        .enumerate()
        .map(|(index, element)| {
            let mut connection = parse_connection_element(element)
                .or_else(|| {
                    let member_urn = first_text([
                        text(element, "connectedMember"),
                        text(element, "*connectedMember"),
                    ]);
                    if member_urn.is_empty() {
                        return None;
                    }
                    let referenced_member_id = member_id_from_urn(member_urn);
                    included
                        .iter()
                        .find(|item| {
                            text(item, "entityUrn") == Some(member_urn)
                                || text(item, "$id") == Some(member_urn)
                                || (!referenced_member_id.is_empty()
                                    && member_id_for(item) == referenced_member_id)
                        })
                        .and_then(parse_connection_element)
                })
                .unwrap_or_else(|| invalid_connection(element, index, page_start));
            if let Value::Object(row) = &mut connection {
                row.insert("connectedAt".into(), connected_at(element));
            }
            connection
        })
        .collect::<Vec<_>>();

    let total = integer(paging.get("total")).filter(|value| *value >= 0);
    let count = number(paging.get("count"))
        .filter(|value| value.is_finite() && *value != 0.0)
        .map(|value| value as i64)
        .unwrap_or(raw_elements.len() as i64);
    let mut output = Map::new();
    output.insert("connections".into(), Value::Array(connections));
    output.insert("rawCount".into(), json!(raw_elements.len()));
    output.insert(
        "total".into(),
        total.map(Value::from).unwrap_or(Value::Null),
    );
    output.insert("count".into(), Value::from(count));
    output.insert("start".into(), Value::from(page_start));
    Value::Object(output)
}

#[no_mangle]
pub extern "C" fn capture_worker_alloc(length: u32) -> u32 {
    let mut buffer = vec![0_u8; length as usize].into_boxed_slice();
    let pointer = buffer.as_mut_ptr() as u32;
    mem::forget(buffer);
    pointer
}

/// Releases a buffer previously returned by `capture_worker_alloc`.
///
/// # Safety
///
/// `pointer` and `length` must describe exactly one live allocation returned
/// by this module, and that allocation must not have been released already.
#[no_mangle]
pub unsafe extern "C" fn capture_worker_dealloc(pointer: u32, length: u32) {
    if pointer == 0 || length == 0 {
        return;
    }
    let raw = std::ptr::slice_from_raw_parts_mut(pointer as *mut u8, length as usize);
    drop(Box::from_raw(raw));
}

/// Returns `(output_length << 32) | output_pointer`, or zero on malformed JSON.
///
/// # Safety
///
/// `pointer..pointer + length` must be a live, initialized allocation returned
/// by `capture_worker_alloc` for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn capture_worker_parse_connections(pointer: u32, length: u32) -> u64 {
    if pointer == 0 || length == 0 {
        return 0;
    }
    let input = slice::from_raw_parts(pointer as *const u8, length as usize);
    let Ok(data) = serde_json::from_slice::<Value>(input) else {
        return 0;
    };
    let Ok(serialized) = serde_json::to_vec(&parse_connections_response(&data)) else {
        return 0;
    };
    if serialized.is_empty() || serialized.len() > u32::MAX as usize {
        return 0;
    }
    let mut output = serialized.into_boxed_slice();
    let output_pointer = output.as_mut_ptr() as u32;
    let output_length = output.len() as u64;
    mem::forget(output);
    (output_length << 32) | u64::from(output_pointer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_connections_and_resolves_included_members() {
        let data = json!({
            "paging": { "start": 10, "count": 2, "total": 12 },
            "elements": [
                {
                    "createdAt": 1733434188000_i64,
                    "connectedMemberResolutionResult": {
                        "firstName": "Ada",
                        "lastName": "Lovelace",
                        "publicIdentifier": "ada-lovelace",
                        "entityUrn": "urn:li:fsd_profile:ada"
                    }
                },
                { "connectedMember": "urn:li:fsd_profile:grace" }
            ],
            "included": [
                {
                    "entityUrn": "urn:li:fsd_profile:grace",
                    "firstName": "Grace",
                    "lastName": "Hopper",
                    "publicIdentifier": "grace-hopper"
                }
            ]
        });
        let parsed = parse_connections_response(&data);
        assert_eq!(parsed["rawCount"], 2);
        assert_eq!(parsed["total"], 12);
        assert_eq!(parsed["connections"][0]["name"], "Ada Lovelace");
        assert_eq!(parsed["connections"][0]["connectedAt"], 1733434188000_i64);
        assert_eq!(parsed["connections"][1]["externalId"], "grace-hopper");
        assert_eq!(parsed["connections"][1]["connectedAt"], Value::Null);
    }

    #[test]
    fn keeps_an_incomplete_observation_for_unresolvable_rows() {
        let parsed = parse_connections_response(&json!({
            "paging": { "start": 20 },
            "elements": [{}]
        }));
        assert_eq!(
            parsed["connections"][0]["externalId"],
            "connection_offset_20"
        );
        assert_eq!(parsed["connections"][0]["_captureIncomplete"], true);
    }
}
