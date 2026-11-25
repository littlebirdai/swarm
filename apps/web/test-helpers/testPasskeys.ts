import { replaceGlobals } from "./globals";

export function testPasskeys() {
  const buf = (n: number) => new Uint8Array(n).fill(7).buffer;
  const ceremonies: ("get" | "create")[] = [];
  const credentials = {
    get: async () => (
      ceremonies.push("get"),
      {
        id: "AQ",
        rawId: buf(1),
        type: "public-key",
        getClientExtensionResults: () => ({}),
        response: {
          authenticatorData: buf(37),
          clientDataJSON: buf(9),
          signature: buf(64),
          userHandle: null,
        },
      }
    ),
    create: async () => (
      ceremonies.push("create"),
      {
        id: "AQ",
        rawId: buf(1),
        type: "public-key",
        getClientExtensionResults: () => ({}),
        response: {
          attestationObject: buf(30),
          clientDataJSON: buf(9),
          getTransports: () => ["internal"],
        },
      }
    ),
  };

  const install = () => {
    Object.defineProperty(navigator, "credentials", {
      value: credentials,
      configurable: true,
    });
    return replaceGlobals({
      PublicKeyCredential: function PublicKeyCredential() {},
    });
  };
  return { install, ceremonies };
}
