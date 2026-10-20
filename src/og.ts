const ogImageUrl = new URL("../web/og.png", import.meta.url);

const readOgImage = () => Deno.readFile(ogImageUrl);

let ogImagePromise: Promise<Uint8Array<ArrayBuffer>> | null = null;

export const ogImageResponse = async () => {
  const image = await (ogImagePromise ??= readOgImage());
  return new Response(image, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "image/png",
    },
  });
};
