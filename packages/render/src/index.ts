// Shared cross-client RENDER logic: pure tool classification + display
// formatting that the web and mobile session views both need. The single source
// of truth that ends the web↔mobile hand-fork drift.
//
// PURE & isomorphic — NO React/JSX, NO document/window/import.meta, NO Node/DOM
// APIs — so it imports cleanly into both the vite browser bundle and the
// Expo/Hermes (React Native) bundle.
export * from "./toolNames";
export * from "./format";
export * from "./toolCall";
export * from "./toolVisual";
export * from "./pageTheme";
export * from "./structuredResult";
export * from "./structuredMessage";
