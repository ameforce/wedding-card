import { pathToFileURL } from "node:url";

export const REQUIRED_ADMIN_DESTINATIONS = Object.freeze([
  "wdcard.enmsoftware.com/admin",
  "wdcard.enmsoftware.com/admin/*",
  "wdcard.enmsoftware.com/api/admin/*",
  "wdcard.enmsoftware.com/api/guestbook/admin/*",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeDestination(uri) {
  return String(uri || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
}

async function readCloudflareResult(response, label) {
  const payload = await response.json().catch(() => null);
  invariant(response.ok && payload?.success, `${label} 조회에 실패했습니다 (${response.status}).`);
  invariant(Array.isArray(payload.result), `${label} 응답 형식이 올바르지 않습니다.`);
  return payload;
}

export async function verifyCloudflareAccess({
  accountId,
  apiToken,
  fetchImpl = fetch,
} = {}) {
  invariant(accountId, "CLOUDFLARE_ACCOUNT_ID가 필요합니다.");
  invariant(apiToken, "CLOUDFLARE_API_TOKEN이 필요합니다.");

  const headers = { authorization: `Bearer ${apiToken}` };
  const applicationsUrl = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps`);
  applicationsUrl.searchParams.set("per_page", "1000");
  const applicationsPayload = await readCloudflareResult(
    await fetchImpl(applicationsUrl, { headers }),
    "Cloudflare Access 애플리케이션",
  );

  const required = new Set(REQUIRED_ADMIN_DESTINATIONS.map(normalizeDestination));
  const matches = applicationsPayload.result.filter((application) => {
    const destinations = new Set(
      (application.destinations || [])
        .filter((destination) => destination?.type === "public")
        .map((destination) => normalizeDestination(destination.uri)),
    );
    return [...required].every((destination) => destinations.has(destination));
  });

  invariant(
    matches.length === 1,
    `정확한 /admin과 기존 관리자 경로를 하나의 Access 애플리케이션으로 보호해야 합니다 (일치 ${matches.length}개).`,
  );

  const application = matches[0];
  invariant(application.type === "self_hosted", "관리자 Access 애플리케이션은 self_hosted 유형이어야 합니다.");
  invariant(application.id, "관리자 Access 애플리케이션 ID가 없습니다.");

  const policiesPayload = await readCloudflareResult(
    await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps/${application.id}/policies?per_page=1000`,
      { headers },
    ),
    "Cloudflare Access 정책",
  );
  invariant(
    policiesPayload.result.some((policy) => policy?.decision === "allow"),
    "관리자 Access 애플리케이션에 허용 정책이 없습니다.",
  );
  invariant(
    !policiesPayload.result.some((policy) => policy?.decision === "bypass"),
    "관리자 Access 애플리케이션에 인증을 우회하는 정책이 있습니다.",
  );

  return {
    applicationId: application.id,
    destinationCount: application.destinations.length,
    requiredDestinations: REQUIRED_ADMIN_DESTINATIONS,
  };
}

async function main() {
  const result = await verifyCloudflareAccess({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  });
  console.log(`Cloudflare Access 관리자 경계 확인: ${result.applicationId} (${result.destinationCount}개 대상)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
