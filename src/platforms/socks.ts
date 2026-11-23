import net from "node:net";

/**
 * Opens a TCP connection to host:port through a SOCKS5 server (no authentication).
 * Used to reach an outbound HTTP proxy that is only reachable through a userspace VPN
 * client (e.g. a NetBird sidecar in netstack mode, which exposes SOCKS5 instead of a tun device).
 */
export function socks5Connect(socksHost: string, socksPort: number, host: string, port: number, timeoutMs = 10_000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socksPort, socksHost);
    let stage = 0;
    let buf = Buffer.alloc(0);
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error(`SOCKS5 ${socksHost}:${socksPort} timed out`)));
    socket.once("error", fail);
    socket.once("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])));

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error("SOCKS5 server refused no-auth method"));
        buf = buf.subarray(2);
        stage = 1;
        const ipType = net.isIP(host);
        let addr: Buffer;
        if (ipType === 4) addr = Buffer.from([0x01, ...host.split(".").map(Number)]);
        else if (ipType === 6) return fail(new Error("SOCKS5 IPv6 targets are not supported"));
        else addr = Buffer.concat([Buffer.from([0x03, Buffer.byteLength(host)]), Buffer.from(host)]);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 0x00) return fail(new Error(`SOCKS5 connect to ${host}:${port} failed (code ${buf[1]})`));
        const atyp = buf[3];
        const len = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : 7 + (buf[4] ?? 0);
        if (buf.length < len) return;
        const rest = buf.subarray(len);
        socket.off("data", onData);
        socket.off("error", fail);
        socket.setTimeout(0);
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      }
    };
    socket.on("data", onData);
  });
}
