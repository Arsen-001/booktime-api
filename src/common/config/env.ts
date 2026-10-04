import 'dotenv/config';
import { z } from 'zod';

/** Конфиг — только из переменных окружения (PLAN.md §2). Неверный конфиг — процесс не стартует. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4010),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3710')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  DATABASE_URL: z.string().startsWith('mysql://'),
  REDIS_URL: z.string().startsWith('redis://'),
  /**
   * Хранилище файлов (04.10.2026, «Файлы и фото»). Заданы S3_BUCKET + S3_ENDPOINT + S3_ACCESS_KEY_ID +
   * S3_SECRET_ACCESS_KEY — всё (фото и выгрузки отчётов) идёт в S3-совместимое хранилище (AWS S3, Cloudflare R2,
   * Railway Buckets); не заданы — диск: фото в UPLOADS_DIR, выгрузки в STORAGE_DIR. STORAGE_DRIVER=s3 без
   * этих четырёх — процесс не стартует (src/adapters/storage/storage.ts::storageConfig).
   */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  /** Выгрузки отчётов на диске (не раздаются наружу) */
  STORAGE_DIR: z.string().default('./storage'),
  /** Фото на диске, раздаются GET /v1/files/<key>. По умолчанию: production — /data/uploads (диск Railway), иначе ./.uploads */
  UPLOADS_DIR: z.string().optional(),
  /** Документы клиентов на диске (закрытые, не раздаются /v1/files). По умолчанию: production — /data/private, иначе ./.private */
  PRIVATE_FILES_DIR: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Адреса вида <endpoint>/<bucket>/<key> (по умолчанию — да: R2, MinIO, Railway); '0' — <bucket>.<endpoint>/<key> */
  S3_FORCE_PATH_STYLE: z.enum(['0', '1']).default('1').transform((v) => v === '1'),
  /** Старые имена тех же ключей (до 04.10.2026) — читаются, если новых нет */
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  /**
   * Публичный адрес бакета (R2: https://files.booktime.am или https://pub-….r2.dev) — ссылки на фото ведут прямо туда.
   * Пусто — фото из S3 раздаёт API тем же GET /v1/files/<key>.
   */
  S3_PUBLIC_URL: z.string().optional(),
  /** Внешний адрес этого API для ссылок на фото (https://api.booktime.am); пусто — из заголовков запроса (Host / X-Forwarded-*) */
  PUBLIC_API_URL: z.string().optional(),
  /** Предел фото на бизнес, МБ (сумма сохранённых файлов); дальше — 422 upload_quota */
  UPLOADS_QUOTA_MB: z.coerce.number().int().positive().default(2048),
  // Вход (этап 2)
  /** Telegram Gateway: есть токен — код в Telegram уходит по-настоящему; нет — заглушка пишет в лог */
  TELEGRAM_GATEWAY_TOKEN: z.string().optional(),
  /**
   * WhatsApp Business Cloud API (03.10.2026): заданы токен и Phone number ID — канал «WhatsApp» включён (по просьбе
   * человека и как запасной, если Telegram не доставил); не заданы — канала нет. См. README «Вход через WhatsApp».
   */
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  /** Имя одобренного шаблона категории AUTHENTICATION (кнопка «Copy code») */
  WHATSAPP_TEMPLATE_NAME: z.string().optional().transform((s) => s || 'booktime_login_code'),
  /** Языки, на которых шаблон одобрен, через запятую; язык выбирается по локали человека, нет такого — первый */
  WHATSAPP_TEMPLATE_LANGS: z
    .string()
    .optional()
    .transform((s) => (s || 'ru,en').split(',').map((x) => x.trim()).filter(Boolean)),
  /** Версия Graph API */
  WHATSAPP_API_VERSION: z.string().optional().transform((s) => s || 'v23.0'),
  /**
   * SMS для кода входа (03.10.2026): самый дорогой канал — последний запасной. Провайдер выбран и ключи заданы —
   * включён; иначе канала нет. Первый провайдер — Twilio (TWILIO_FROM или TWILIO_MESSAGING_SERVICE_SID).
   */
  SMS_PROVIDER: z.enum(['twilio']).optional().or(z.literal('').transform(() => undefined)),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  /** Номер Twilio (+1…) или Alphanumeric Sender ID ('BookTime') */
  TWILIO_FROM: z.string().optional(),
  /** Messaging Service SID (MG…) — вместо TWILIO_FROM */
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  /** Защита от накрутки: SMS только на номера с этими префиксами, через запятую */
  SMS_ALLOWED_PREFIXES: z
    .string()
    .optional()
    .transform((s) => (s || '+374').split(',').map((x) => x.trim()).filter(Boolean)),
  /** Защита от накрутки: не больше стольких SMS с кодом в час на весь сервис (остальным — Telegram/WhatsApp) */
  SMS_MAX_PER_HOUR: z.coerce.number().int().positive().default(100),
  /**
   * «Войти через Google» (03.10.2026): OAuth Client ID из Google Cloud Console — через запятую, если клиентов несколько
   * (web, android, ios): у ID token поле aud должно совпасть с одним из них. Пусто — вход через Google выключен.
   */
  GOOGLE_CLIENT_ID: z
    .string()
    .optional()
    .transform((s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)),
  /**
   * «Войти через Apple» (03.10.2026): bundle id приложений (am.booktime.app, am.booktime.business) и Services ID сайта —
   * через запятую: у identity token поле aud должно совпасть с одним из них. Пусто — вход через Apple выключен.
   */
  APPLE_CLIENT_IDS: z
    .string()
    .optional()
    .transform((s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)),
  /**
   * Отзыв входа через Apple при удалении аккаунта (04.10.2026, App Store 5.1.1(v)): ключ Sign in with Apple из Apple
   * Developer → Keys (.p8). Заданы все три — сервер при входе меняет authorizationCode на refresh token, а при удалении
   * аккаунта отзывает его (https://appleid.apple.com/auth/revoke). Не заданы — вход работает, отзыв пропускается (warn).
   */
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  /** Содержимое .p8 (-----BEGIN PRIVATE KEY----- …) — с настоящими переводами строк или \n */
  APPLE_PRIVATE_KEY: z
    .string()
    .optional()
    .transform((s) => (s ? s.replace(/\\n/g, '\n') : undefined)),
  /**
   * Ключ шифрования секретов в базе (04.10.2026; сейчас — refresh token Apple): 32 байта в base64 или hex
   * (`openssl rand -base64 32`). Нет — токены Apple не сохраняются (отзыв при удалении невозможен). Сменить нельзя без
   * потери сохранённых токенов.
   */
  SECRETS_KEY: z.string().optional(),
  /**
   * Уборка неиспользуемых файлов (04.10.2026): воркер каждую ночь ищет загрузки старше 7 дней, на которые ничего не
   * ссылается. Без '1' — только пишет в лог, что удалил бы (пробный режим); '1' — удаляет файлы и строки uploads.
   */
  UPLOADS_CLEANUP: z.string().optional().transform((v) => v === '1'),
  /** Постоянный код входа только для разработки (NODE_ENV=development); в остальных средах игнорируется */
  DEV_LOGIN_CODE: z.string().regex(/^\d{4}$/).optional(),
  /**
   * Вход проверяющих App Store / Google Play (04.10.2026, docs/store/review-notes.md фронта). Оба заданы — номера из
   * REVIEW_LOGIN_PHONES (E.164 через запятую, '+37400000101,+37400000102') входят постоянным кодом REVIEW_LOGIN_CODE
   * (4 цифры), сообщение никуда не отправляется; лимиты и попытки — как у всех. Пусто хотя бы одно — выключено.
   */
  REVIEW_LOGIN_PHONES: z
    .string()
    .optional()
    .transform((s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^\+\d{8,15}$/, 'REVIEW_LOGIN_PHONES: номера в формате +374XXXXXXXX через запятую'))),
  REVIEW_LOGIN_CODE: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().regex(/^\d{4}$/, 'REVIEW_LOGIN_CODE: ровно 4 цифры').optional()),
  /** Домен cookie сессии (прод: .booktime.am — чтобы сайт и API на поддоменах видели одну сессию); пусто — хост API */
  COOKIE_DOMAIN: z.string().optional(),
  /** Cookie только по HTTPS (прод — да) */
  COOKIE_SECURE: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
  /** Сколько дней живёт сессия без захода (продлевается при каждом заходе) */
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(60),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  // Уведомления (этап 10, PLAN.md Р14): Web Push и FCM настоящие — есть ключи, шлём по-настоящему; нет — заглушка в лог
  /** Пара VAPID (сгенерировать один раз: `npx web-push generate-vapid-keys`) */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** 'mailto:ops@booktime.am' — по спецификации Web Push, контакт для провайдера */
  VAPID_SUBJECT: z.string().default('mailto:ops@booktime.am'),
  /** Firebase-сервисный аккаунт (Project Settings → Service accounts → Generate key) для FCM HTTP v1 */
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  /** Как в JSON-файле сервисного аккаунта — с настоящими переводами строк (\n экранированный тоже принимается) */
  FCM_PRIVATE_KEY: z.string().optional(),
  // Telegram-бот напоминаний (30.09.2026, решение владельца: бесплатный канал для клиентов без приложения).
  /** Токен от @BotFather: есть — бот настоящий (Bot API); нет — заглушка пишет сообщения в лог */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** Имя бота без @ — для ссылки https://t.me/<имя>?start=<код> */
  TELEGRAM_BOT_USERNAME: z.string().optional().transform((s) => (s || 'booktime_bot').replace(/^@/, '')),
  /** Секрет вебхука (setWebhook secret_token): задан — POST /v1/telegram/webhook без верного заголовка отклоняется */
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  /** '1' — воркер сам забирает обновления getUpdates (разработка без публичного адреса); прод — вебхук */
  TELEGRAM_BOT_POLLING: z.string().optional().transform((v) => v === '1'),
  /** Адрес сайта для ссылок в сообщениях (кнопка «Перенести» → <адрес>/b/<slug>) */
  PUBLIC_SITE_URL: z.string().optional().transform((s) => (s || 'https://booktime.am').replace(/\/+$/, '')),
  /** '1' — воркер раз в сутки (04:30 Ереван) пишет копию базы в DB_BACKUP_DIR (jobs/db-backup.ts) */
  DB_BACKUP: z.string().optional().transform((v) => v === '1'),
  /** Папка копий — НЕ внутри STORAGE_DIR (хранилище раздаёт файлы); Railway: /data/backups */
  DB_BACKUP_DIR: z.string().default('./backups'),
  /** Sentry (мониторинг ошибок): DSN проекта booktime-api; без него — выключен */
  SENTRY_DSN: z.string().optional(),
  /** Имя окружения в Sentry; по умолчанию RAILWAY_ENVIRONMENT_NAME (staging / production) */
  SENTRY_ENVIRONMENT: z.string().optional(),
  /**
   * Общий секрет с сайтом (04.10.2026): страницы сайта, которые сервер Vercel рисует сам (SSR: главная, /b/<slug>,
   * /masters/<id>, поиск), шлют его заголовком X-BT-SSR. С верным секретом публичные GET-лимиты по IP умножаются на
   * SSR_RATE_MULTIPLIER (все посетители сайта приходят с нескольких адресов Vercel). Пусто — обычные лимиты для всех.
   * То же значение — в SSR_SHARED_SECRET проекта Vercel (booking-platform, docs/DEPLOY.md).
   */
  SSR_SHARED_SECRET: z.string().optional().transform((s) => s?.trim() || undefined),
  SSR_RATE_MULTIPLIER: z.coerce.number().int().min(1).max(1000).default(20),
  /**
   * Сколько прокси перед API (Express `trust proxy`): Railway — 1, тогда IP для лимитов — настоящий адрес клиента из
   * X-Forwarded-For, а не адрес прокси Railway. Пусто — заголовку не верим (локально).
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).optional(),
  /** Сколько последних ежедневных копий хранить */
  DB_BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Неверные переменные окружения (см. .env.example):\n${lines}`);
  }
  return parsed.data;
}

export const env: Env = load();
