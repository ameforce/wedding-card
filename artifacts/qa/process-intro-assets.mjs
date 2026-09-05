// imagegen 에셋 → 인트로 커버용 최적화 webp 변환 (트리밍 + 리사이즈)
import sharp from "sharp";
import { access } from "node:fs/promises";

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

const JOBS = [
  {
    name: "paper",
    src: "C:/Users/enmso/Downloads/ChatGPT Image 2026년 9월 5일 오후 12_00_54.png",
    out: "public/assets/design/intro-paper-ivory.webp",
    alpha: false,
    targetWidth: 1254,
  },
  {
    name: "band",
    src: "C:/Users/enmso/Downloads/ChatGPT Image 2026년 9월 5일 오후 12_01_04.png",
    out: "public/assets/design/intro-ribbon-band.webp",
    alpha: true,
    targetWidth: 1600,
  },
  {
    name: "bow",
    src: "C:/Users/enmso/Downloads/ChatGPT Image 2026년 9월 5일 오후 12_01_16.png",
    out: "public/assets/design/intro-ribbon-bow.webp",
    alpha: true,
    targetWidth: 640,
  },
  {
    name: "bow-f1",
    src: "C:/Users/enmso/Downloads/ChatGPT Image 2026년 9월 5일 오후 01_43_39.png",
    out: "public/assets/design/intro-ribbon-bow-f1.webp",
    alpha: true,
    targetWidth: 640,
  },
  {
    name: "bow-f2",
    src: "C:/Users/enmso/Downloads/ChatGPT Image 2026년 9월 5일 오후 01_43_41.png",
    out: "public/assets/design/intro-ribbon-bow-f2.webp",
    alpha: true,
    targetWidth: 640,
  },
  {
    name: "bow-f3",
    src: "C:/Users/enmso/Downloads/ChatGPT Image 2026년 9월 5일 오후 01_43_59.png",
    out: "public/assets/design/intro-ribbon-bow-f3.webp",
    alpha: true,
    targetWidth: 640,
  },
];

async function alphaBoundingBox(src) {
  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
  if (info.channels < 4) return { left: 0, top: 0, width: info.width, height: info.height };
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("완전히 투명한 이미지입니다: " + src);
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

for (const job of JOBS) {
  if (!(await exists(job.src))) {
    if (await exists(job.out)) {
      console.log(`${job.name}: 소스 없음, 기존 산출물 유지 (${job.out})`);
      continue;
    }
    throw new Error(`소스와 산출물이 모두 없습니다: ${job.src}`);
  }
  let pipeline = sharp(job.src);
  if (job.alpha) {
    const box = await alphaBoundingBox(job.src);
    pipeline = pipeline.extract(box);
    console.log(`${job.name} alpha bbox:`, JSON.stringify(box));
  }
  pipeline = pipeline.resize({ width: job.targetWidth, withoutEnlargement: true }).webp({ quality: 82, alphaQuality: 90 });
  const info = await pipeline.toFile(job.out);
  console.log(`${job.name} -> ${job.out} (${info.width}x${info.height})`);
}
