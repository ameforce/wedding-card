// imagegen 에셋 검사: 치수, 알파 채널, 모서리 픽셀 상태 보고
import sharp from "sharp";

const files = [
  ["paper", "C:/Users/enmso/Downloads/ChatGPT Image 2026년 9월 5일 오후 12_00_54.png"],
  ["band", "C:/Users/enmso/Downloads/ChatGPT Image 2026년 9월 5일 오후 12_01_04.png"],
  ["bow", "C:/Users/enmso/Downloads/ChatGPT Image 2026년 9월 5일 오후 12_01_16.png"],
];

for (const [name, file] of files) {
  const img = sharp(file);
  const meta = await img.metadata();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return Array.from(data.slice(i, i + info.channels));
  };
  const corners = {
    topLeft: px(0, 0),
    topRight: px(info.width - 1, 0),
    bottomLeft: px(0, info.height - 1),
    bottomRight: px(info.width - 1, info.height - 1),
  };
  // 알라파 분포 요약 (채널이 4개일 때)
  let transparentCount = 0;
  let opaqueCount = 0;
  if (info.channels === 4) {
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 16) transparentCount++;
      else if (data[i] > 240) opaqueCount++;
    }
    const total = (data.length / 4) | 0;
    var alphaStats = {
      transparentPct: ((transparentCount / total) * 100).toFixed(1),
      opaquePct: ((opaqueCount / total) * 100).toFixed(1),
    };
  }
  console.log(JSON.stringify({ name, width: meta.width, height: meta.height, channels: info.channels, corners, alphaStats }));
}
