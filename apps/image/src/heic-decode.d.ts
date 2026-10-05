declare module "heic-decode" {
  interface DecodedImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  interface ImageHandle {
    width: number;
    height: number;
    decode(): Promise<DecodedImage>;
  }
  const decode: {
    all(options: {
      buffer: Uint8Array;
    }): Promise<ImageHandle[] & { dispose(): void }>;
  };
  export default decode;
}
