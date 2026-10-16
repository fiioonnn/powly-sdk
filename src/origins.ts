// The Powly origins this build of the SDK trusts by default: a game only handshakes with a parent
// page on one of them (unless it passes `powlyOrigin` to `Powly.init()` itself). Set at build
// time with POWLY_SDK_ORIGINS (comma-separated origins); scripts/bundle.ts writes the list
// into dist. Without it: Powly's production origin and the local development app.

export const POWLY_ORIGINS: readonly string[] = ["https://powly.gg", "http://localhost:3000"];
