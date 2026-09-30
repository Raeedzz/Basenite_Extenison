/**
 * The Claude desktop connector (.mcpb): the MCP server shipped in this
 * extension, zipped with a manifest that carries this extension's id.
 * Double-clicking it installs it in Claude, which runs it with its own Node.
 */
export const CONNECTOR_FILE = "basanite.mcpb";
const ENTRY = "server/basanite-mcp.mjs";

export function connectorManifest({ extensionId, version, port = null }) {
  return {
    manifest_version: "0.2",
    name: "basanite",
    display_name: "Basanite Capital",
    // mcpb wants semver; Chrome allows "1.1".
    version: `${version}.0.0`.split(".").slice(0, 3).join("."),
    description: "Drive the Basanite Chrome extension: sync and enrich LinkedIn people, companies and mutuals into Airtable.",
    author: { name: "Basanite Capital" },
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: ENTRY,
      mcp_config: {
        command: "node",
        args: [`\${__dirname}/${ENTRY}`],
        env: { BASANITE_EXTENSION_ID: extensionId, ...(port ? { BASANITE_MCP_PORT: String(port) } : {}) },
      },
    },
    tools_generated: true,
    compatibility: { platforms: ["darwin", "win32"], runtimes: { node: ">=18.0.0" } },
  };
}

/** `script` is the server's source, `icon` PNG bytes. */
export function buildConnector({ script, icon, ...options }) {
  const text = (value) => new TextEncoder().encode(value);
  return zip([
    { name: "manifest.json", data: text(JSON.stringify(connectorManifest(options), null, 2)) },
    { name: ENTRY, data: text(script) },
    { name: "icon.png", data: icon },
  ]);
}

// ─── Stored (uncompressed) zip ───────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zip(files) {
  const DOS_DATE = 0x21; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [12, DOS_DATE, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, nameBytes.length, 2]]
      .forEach(([at, value, size]) => (size === 4 ? local.setUint32(at, value, true) : local.setUint16(at, value, true)));
    const central = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [14, DOS_DATE, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, nameBytes.length, 2], [42, offset, 4]]
      .forEach(([at, value, size]) => (size === 4 ? central.setUint32(at, value, true) : central.setUint16(at, value, true)));
    locals.push(new Uint8Array(local.buffer), nameBytes, data);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
