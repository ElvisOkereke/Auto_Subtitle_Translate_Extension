// TypeScript's "node" module resolution ignores package subpath exports;
// 'onnxruntime-web/webgpu' (resolved by webpack) shares the root package's API.
declare module 'onnxruntime-web/webgpu' {
  export * from 'onnxruntime-web';
}
