// Настройка службы `api` на Railway (Infrastructure as Code) — замена railway.json.
// Railway перестаёт читать railway.json 01.12.2026. Этот файл Railway сам при выкладке не читает:
// его применяет CLI (`railway config plan` → `railway config apply`) отдельно для каждого окружения.
//
// partial "api": файл управляет только тем, что в нём объявлено (служба api и её диск api-volume).
// MySQL, Redis и их диски файл не трогает и не удаляет.
// Переменные (секреты) заданы в панели Railway — `managed: false`, файл их не трогает.
// Порядок перехода и откат — docs/DEPLOY.md в booking-platform.
//
// Перед apply план не должен показывать строк про api-volume: смена региона или уменьшение диска —
// перенос или потеря данных. Увеличили диск в панели — сначала поправьте sizeMB здесь.
import { defineRailway, github, project, service, volume } from "railway/iac";

export const partial = "api";

// Нидерланды (EU West). Без явного региона служба уезжала в us-west2.
const REGION = "europe-west4-drams3a";

const ENVIRONMENTS = {
  production: { branch: "main", domain: "api.booktime.am" },
  staging: { branch: "develop", domain: "api-staging.booktime.am" },
} as const;

export default defineRailway((ctx) => {
  const env = ENVIRONMENTS[ctx.environment as keyof typeof ENVIRONMENTS];
  if (!env) {
    throw new Error(
      `railway.ts: окружение «${ctx.environment}» не описано — только production и staging`,
    );
  }

  // Общий диск API и воркера: копии базы, фото, документы клиентов (/data).
  const apiVolume = volume("api-volume", { region: REGION, sizeMB: 5000 });

  const api = service("api", {
    source: github("Arsen-001/booktime-api", { branch: env.branch, checkSuites: false }),
    build: { builder: "RAILPACK", buildEnvironment: "V3", buildCommand: "npm run build:prod" },
    start: "node scripts/railway-start.mjs",
    healthcheck: "/v1/health",
    healthcheckTimeout: 120,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5 },
    replicas: { [REGION]: 1 },
    domains: [env.domain],
    volumeMounts: { "/data": apiVolume },
  });

  // variables.managed: false — CLI не трогает переменные (без этого план отказывается: «api declares no env»).
  // Поле читает CLI, в типах SDK railway 3.17 его ещё нет — поэтому объект отдельной константой.
  const definition = {
    variables: { managed: false },
    resources: [api, apiVolume],
  };
  return project("booktime", definition);
});
