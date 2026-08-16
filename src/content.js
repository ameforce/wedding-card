export const DESIGN_ASSETS = {
  quietLight: "/assets/design/quiet-light-study.webp",
  pastelWash: "/assets/design/pastel-watercolor-wash.webp",
  map: "/assets/design/abstract-map.webp",
};

const photo = (name, alt, position) => ({
  src: `/assets/photos/${name}-480.webp`,
  srcSet: `/assets/photos/${name}-480.webp 480w, /assets/photos/${name}-960.webp 960w`,
  sizes: "(min-width: 768px) 430px, 100vw",
  alt,
  position,
});

export const WEDDING_PHOTOS = {
  quiet: {
    hero: photo("quiet-hero", "아치형 공간에서 서로를 바라보는 신랑과 신부의 스튜디오 사진", "50% 42%"),
    gallery: [
      photo("quiet-gallery-1", "창가에서 함께 선 신랑과 신부의 스튜디오 사진", "50% 33%"),
      photo("quiet-gallery-2", "꽃잎이 흩날리는 장면의 신랑과 신부 스튜디오 사진", "50% 34%"),
      photo("quiet-gallery-3", "종이 소품을 들고 미소 짓는 신랑과 신부의 스튜디오 사진", "50% 58%"),
    ],
  },
  pastel: {
    gallery: [
      photo("pastel-gallery-1", "밝은 커튼 사이에서 함께 웃는 신랑과 신부의 스튜디오 사진", "50% 39%"),
      photo("pastel-gallery-2", "초록빛 야외 배경에 함께 선 신랑과 신부의 스튜디오 사진", "50% 31%"),
      photo("pastel-gallery-3", "흰 꽃 사이에 앉아 있는 신랑과 신부의 스튜디오 사진", "50% 31%"),
      photo("pastel-gallery-4", "밝은 커튼 사이에서 미소 짓는 신부의 스튜디오 사진", "50% 26%"),
    ],
  },
};

export const SESANG_STICKERS = {
  left: "/assets/stickers/sesang-left.webp",
  right: "/assets/stickers/sesang-right.webp",
  sleep: "/assets/stickers/sesang-sleep.webp",
};

export const weddingContent = {
  isDesignPlaceholder: true,
  couple: {
    groom: "김종인",
    bride: "유지혜",
  },
  event: {
    isoDate: "2026-12-27",
    date: "2026.12.27",
    day: "일요일",
    time: "오후 3시",
    timezone: null,
  },
  venue: {
    name: "더 바실리움",
    address: "실제 주소 입력 예정",
    mapLinks: {
      naver: "https://naver.me/GOPesFwZ",
      kakao: "https://place.map.kakao.com/518455120",
      tmap: "https://tmap.life/03fe38e6",
    },
  },
  message: [
    "서로를 아끼며 믿음으로",
    "한 걸음 한 걸음 함께 걷겠습니다.",
    "이 자리에 함께해 주시면",
    "더없는 기쁨이 되겠습니다.",
  ],
  calendar: {
    year: 2026,
    month: 12,
    day: 27,
    weekdays: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
  },
  timeline: [
    { label: "예식 안내", time: "오후 3시" },
    { label: "식사 안내", time: "시간 미정" },
    { label: "연회 및 축가", time: "시간 미정" },
  ],
  story: [
    "처음 만난 순간부터",
    "서로의 하루가 되어주었고,",
    "같은 곳을 바라보며",
    "함께 계절을 걸어갑니다.",
  ],
  transit: {
    subway: "노선·출구 정보 입력 예정",
    bus: "정류장·버스 정보 입력 예정",
    car: "주차 안내 입력 예정",
  },
};
