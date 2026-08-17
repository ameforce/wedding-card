export function getCalendarMonth({ year, month, day }) {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

  return Array.from({ length: cellCount }, (_, index) => {
    const date = index - firstWeekday + 1;
    if (date < 1 || date > daysInMonth) return null;

    return {
      date,
      weekday: index % 7,
      isEvent: date === day,
    };
  });
}

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
    hero: photo("pastel-hero", "꽃잎이 흩날리는 야외에서 함께 선 신랑과 신부의 스튜디오 사진", "50% 58%"),
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
  unconfirmedContent: [
    { key: "rsvp.contract", label: "RSVP 운영 계약(수집 항목·마감일·수신자·보존 정책)" },
    { key: "publishing.discovery", label: "공개 노출 설정(OG 메타데이터·검색 노출)" },
  ],
  publishing: {
    canonicalUrl: "https://wdcard.enmsoftware.com/",
  },
  couple: {
    groom: "김종인",
    bride: "유지혜",
  },
  familyContacts: {
    groom: {
      key: "groom",
      label: "신랑 측",
      emoji: "🤵",
      parents: ["김웅기", "홍정화"],
      childRole: "장남",
      childName: "김종인",
      contacts: [
        { relation: "신랑", name: "김종인", phone: "010-7322-2473" },
        { relation: "아버지", name: "김웅기", phone: "010-2511-2473" },
        { relation: "어머니", name: "홍정화", phone: "010-7422-2473" },
      ],
    },
    bride: {
      key: "bride",
      label: "신부 측",
      emoji: "👰",
      parents: ["유효상", "정소은"],
      childRole: "장녀",
      childName: "유지혜",
      contacts: [
        { relation: "신부", name: "유지혜", phone: "010-6803-6841" },
        { relation: "아버지", name: "유효상", phone: "010-8903-9679" },
        { relation: "어머니", name: "정소은", phone: "010-5161-6841" },
      ],
    },
  },
  accounts: {
    groom: {
      key: "groom",
      label: "신랑 측",
      emoji: "🤵",
      bank: "기업은행",
      number: "12306556901011",
      holder: "김종인",
    },
    bride: {
      key: "bride",
      label: "신부 측",
      emoji: "👰",
      bank: "국민",
      number: "64970201592781",
      holder: "유지혜",
    },
  },
  event: {
    isoDate: "2026-12-27",
    date: "2026.12.27",
    dateLabel: "2026년 12월 27일",
    day: "일요일",
    time: "오후 3시",
    startTime24h: "15:00",
    timezone: {
      iana: "Asia/Seoul",
      utcOffset: "+09:00",
    },
  },
  venue: {
    name: "더 바실리움",
    floor: "8층",
    address: "경기 성남시 분당구 양현로 322",
    mapLinks: {
      naver: "https://naver.me/GOPesFwZ",
      kakao: "https://place.map.kakao.com/518455120",
      tmap: "https://tmap.life/03fe38e6",
    },
    map: {
      localAssetPath: "/assets/map/venue-map.webp",
      alt: "더 바실리움 주변 실제 지도와 위치 핀",
      sourceAttribution: "카카오맵",
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
    weekdays: ["일", "월", "화", "수", "목", "금", "토"],
  },
  story: [
    "처음 만난 순간부터",
    "서로의 하루가 되어주었고,",
    "같은 곳을 바라보며",
    "함께 계절을 걸어갑니다.",
  ],
  transit: {
    subway: "수인분당선 야탑역 4번 출구에서 도보 400m",
    shuttle: "야탑역 4번 출구에서 10~15분 간격으로 운행",
    parking: "B2·B4 주차장 이용 · 2시간 무료",
    parkingRegistrationLocation: "웨딩홀·연회장 앞",
    parkingRegistration: "8층 웨딩홀 로비 주차등록 기기에서 등록",
  },
};
