export {};

declare module "node:util" {
  interface TextDecoder {
    decode(input?: ArrayBuffer | ArrayBufferView<ArrayBufferLike>, options?: { stream?: boolean }): string;
  }
}

declare global {
  interface TextDecoder {
    decode(input?: ArrayBuffer | ArrayBufferView<ArrayBufferLike>, options?: { stream?: boolean }): string;
  }
}
