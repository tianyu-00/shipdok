import { isPrivateAddress, normalizeAddress, classifyVisitor, hostOf } from "../src/visitor.js";

describe("normalizeAddress", () => {
  test.each([
    ["::ffff:192.168.1.5", "192.168.1.5"],
    ["::FFFF:10.0.0.1", "10.0.0.1"],
    ["127.0.0.1", "127.0.0.1"],
    ["2001:db8::1", "2001:db8::1"],
    [" 203.0.113.9 ", "203.0.113.9"],
    ["fe80::1%eth0", "fe80::1"],
    [undefined, ""],
    [null, ""],
  ])("%s -> %s", (given, shown) => expect(normalizeAddress(given)).toBe(shown));
});

describe("isPrivateAddress", () => {
  test.each([
    "127.0.0.1", "127.9.9.9", "::1", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.19.0.1", "172.31.255.255",
    "192.168.0.1", "192.168.255.255", "169.254.1.1", "100.64.0.1", "100.127.255.255", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:192.168.1.5",
  ])("%s is on the local network", (a) => expect(isPrivateAddress(a)).toBe(true));

  test.each([
    "8.8.8.8", "1.1.1.1", "203.0.113.9", "172.15.255.255", "172.32.0.1", "192.169.0.1", "100.63.255.255", "100.128.0.1", "11.0.0.1", "2001:db8::1", "2606:4700::1111",
    "", "not-an-address", "999.1.1.1", "10.0.0", "::ffff:8.8.8.8", undefined,
  ])("%s is not (or cannot be shown to be)", (a) => expect(isPrivateAddress(a)).toBe(false));
});

describe("hostOf", () => {
  test.each([
    ["Shipdok.Example.com", "shipdok.example.com"],
    ["shipdok.example.com:8443", "shipdok.example.com"],
    ["https://shipdok.example.com", "shipdok.example.com"],
    ["[::1]:8080", "::1"],
    ["", ""],
    [undefined, ""],
  ])("%s -> %s", (given, shown) => expect(hostOf(given)).toBe(shown));
});

const base = { socket: "127.0.0.1", hasForwardedHeaders: false, hasForwardedFor: false, socketTrusted: true, clientIp: "127.0.0.1", hosts: ["localhost:8080"], publicHost: "" };
const who = (over) => classifyVisitor({ ...base, ...over });

describe("classifyVisitor: a connection with no proxy in it", () => {
  test("from this machine or the local network is local", () => {
    expect(who({})).toBe("local");
    expect(who({ socket: "192.168.1.20", clientIp: "192.168.1.20" })).toBe("local");
    expect(who({ socket: "172.19.0.1", clientIp: "172.19.0.1" })).toBe("local");
  });

  test("straight from the internet is outside", () => {
    expect(who({ socket: "203.0.113.9", clientIp: "203.0.113.9" })).toBe("outside");
  });

  test("a public socket cannot make itself local by claiming a private client", () => {
    expect(who({ socket: "203.0.113.9", clientIp: "192.168.1.5", hasForwardedHeaders: true, hasForwardedFor: true, socketTrusted: false })).toBe("outside");
  });
});

describe("classifyVisitor: through a proxy", () => {
  const via = { hasForwardedHeaders: true, hasForwardedFor: true, socket: "172.19.0.4" };

  test("a trusted proxy reporting a local client: local", () => {
    expect(who({ ...via, clientIp: "192.168.1.20" })).toBe("local");
    expect(who({ ...via, clientIp: "10.0.0.7" })).toBe("local");
  });

  test("a trusted proxy reporting a public client: outside", () => {
    expect(who({ ...via, clientIp: "203.0.113.9" })).toBe("outside");
    expect(who({ ...via, clientIp: "2606:4700::1111" })).toBe("outside");
  });

  test("a forwarder we do not trust is outside, whatever it says", () => {
    expect(who({ ...via, socketTrusted: false, clientIp: "192.168.1.20" })).toBe("outside");
  });

  test("forwarding headers without X-Forwarded-For (no usable client address) fail closed", () => {
    expect(who({ ...via, hasForwardedFor: false, clientIp: "172.19.0.4" })).toBe("outside");
  });

  test("an unreadable client address fails closed", () => {
    expect(who({ ...via, clientIp: "" })).toBe("outside");
    expect(who({ ...via, clientIp: "garbage" })).toBe("outside");
  });
});

describe("classifyVisitor: requests addressed to the public hostname", () => {
  const publicHost = "shipdok.example.com";

  test("without a client address proven by a proxy they are outside, even from a private socket", () => {
    expect(who({ publicHost, hosts: ["shipdok.example.com"] })).toBe("outside");
    expect(who({ publicHost, hosts: ["localhost", "shipdok.example.com:443"] })).toBe("outside");
  });

  test("with a proxy-proven local client they are local (someone at home using the public name)", () => {
    expect(who({ publicHost, hosts: ["shipdok.example.com"], hasForwardedHeaders: true, hasForwardedFor: true, socket: "172.19.0.4", clientIp: "192.168.1.20" })).toBe("local");
  });

  test("with a proven public client they are outside", () => {
    expect(who({ publicHost, hosts: ["shipdok.example.com"], hasForwardedHeaders: true, hasForwardedFor: true, socket: "172.19.0.4", clientIp: "203.0.113.9" })).toBe("outside");
  });

  test("other hostnames are not affected", () => {
    expect(who({ publicHost, hosts: ["localhost:8080"] })).toBe("local");
  });

  test("the dashboard's web server adds an address of its own to every request: that alone does not vouch for a visitor using the public name", () => {
    const viaNginx = { publicHost, hasForwardedHeaders: true, hasForwardedFor: true, clientVouched: false, socket: "172.19.0.4", clientIp: "172.19.0.1" };
    expect(who({ ...viaNginx, hosts: ["shipdok.example.com"] })).toBe("outside");
    expect(who({ ...viaNginx, hosts: ["localhost:8080"] })).toBe("local");
    expect(who({ ...viaNginx, clientVouched: true, hosts: ["shipdok.example.com"], clientIp: "192.168.1.20" })).toBe("local");
  });

  test("no public address set: the hostname rule does not apply", () => {
    expect(who({ publicHost: "", hosts: ["shipdok.example.com"] })).toBe("local");
  });
});
