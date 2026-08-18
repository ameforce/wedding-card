import sharp from "sharp";

const assets = [
  { source: "artifacts/source-assets/quiet-light-study.png", target: "public/assets/design/quiet-light-study.webp", width: 860, quality: 82 },
  { source: "artifacts/source-assets/pastel-watercolor-wash.png", target: "public/assets/design/pastel-watercolor-wash.webp", width: 1200, quality: 84 },
  { source: "artifacts/source-assets/abstract-map.png", target: "public/assets/design/abstract-map.webp", width: 1200, quality: 80 },
];

for (const asset of assets) {
  await sharp(asset.source)
    .resize({ width: asset.width, withoutEnlargement: true })
    .webp({ quality: asset.quality, effort: 6 })
    .toFile(asset.target);
  const metadata = await sharp(asset.target).metadata();
  console.log(`${asset.target}: ${metadata.width}x${metadata.height}`);
}
