import { monotonicFactory } from 'ulid';

/**
 * Идентификаторы `<префикс>_<ULID>` (docs/backend/01-data-model.md §0). Префиксы ядра — те же, что ID_PREFIX
 * во фронте (booking-platform/src/api/core.ts), чтобы экраны работали со строками как раньше.
 * ULID сортируется по времени и не выдаёт количество записей. Длина: префикс ≤ 5 + '_' + 26 ≤ 32 (VARCHAR(32)).
 */
export const ID_PREFIX = {
  // ядро (как во фронте)
  network: 'net',
  business: 'biz',
  location: 'loc',
  staff: 'st',
  serviceCategory: 'cat',
  service: 'sv',
  resource: 'res',
  client: 'cl',
  appUser: 'au',
  booking: 'bk',
  groupEvent: 'ev',
  schedule: 'sch',
  calendarMark: 'mk',
  // новые таблицы сервера
  // человек (users) = AppUser мока: тот же префикс, чтобы экраны клиента работали с id как раньше
  user: 'au',
  session: 'ses',
  auditEvent: 'aud',
  file: 'fil',
  notification: 'ntf',
  otp: 'otp',
  staffLogin: 'sl',
  platformMember: 'pm',
  loginEvent: 'le',
  pushToken: 'pt',
  // этап 3 — как в срезе staff фронта
  position: 'stpos',
  staffInvite: 'stinv',
  // этап 4 — каталог: категории/услуги/пакеты используют cat/sv (пакет — обычная услуга, 01 §4);
  // у ресурса — свои экземпляры (Resource.instances, JSON, как во фронте)
  resourceInstance: 'resinst',
  // этап 5 — клиенты/CRM: client уже был зарезервирован (как во фронте); остальное — только на сервере,
  // не мирроруется в ядро браузера, поэтому префикс свой, фронтовому ID_PREFIX не обязан совпадать
  clientComment: 'ccmt',
  clientFile: 'cfile',
  clientImportRun: 'cimp',
  dataExport: 'dexp',
  clientCustomField: 'cf',
  // этап 6 — график и окна: как в срезе schedule фронта (шаблон sctpl, история scha, правило scr, закрытые дни scun)
  scheduleTemplate: 'sctpl',
  scheduleHistory: 'scha',
  slotRule: 'scr',
  unavailableRange: 'scun',
  busyBlock: 'bb',
  resourceBusy: 'rbz',
  // этап 7 — журнал и записи: как в срезе journal / ядре фронта (визит vis, событие bev, история bh, пакет pkg,
  // лист ожидания wl, серия scser/ser, заявка «закрыть окно» clm, план лечения tplan/tpi, оплата pay, товар gl)
  visit: 'vis',
  bookingEvent: 'bev',
  bookingHistory: 'bh',
  packageGroup: 'pkg',
  waitlistEntry: 'wl',
  seriesRule: 'scser',
  recurrenceSeries: 'ser',
  freedSlot: 'fs',
  slotClaim: 'clm',
  treatmentPlan: 'tplan',
  treatmentPlanItem: 'tpi',
  payment: 'pay',
  goodsLine: 'gl',
  bookingCategory: 'bc',
  recurrenceTemplate: 'rt',
  // этап 8 — онлайн-запись и страница по ссылке: как в срезе online фронта (ссылка lnk)
  bookingLink: 'lnk',
  // этап 9 — приложение клиента: только на сервере, не мирроруются в ядро браузера (как этап 5) — свои префиксы
  favorite: 'fav',
  starRating: 'str',
  diaryEntry: 'dia',
  callbackRequest: 'cbr',
  demandLead: 'lead',
  supportTicket: 'sup',
  /// Лента /v1/me/inbox (F-14-055) — тот же смысл, что зарезервированный на этапе 2 'ntf' (уведомление)
  inboxItem: 'ntf',
  // этап 10 — уведомления: очередь/журнал отправок, новости
  notifyOutbox: 'nto',
  newsPost: 'nws',
  // этап 11 — лояльность: только на сервере (как этапы 5/9) — мок фронта не резервирует префиксы для
  // loyalty в core.ts (id там произвольные строки), поэтому префиксы свои: тип карты lct, карта lc,
  // акция lp, движение ltx, тип/сертификат lctt/lcert, тип/абонемент lmt/lm(+freeze lmf), тип/счёт lat/la(+lao)
  loyaltyCardType: 'lct',
  loyaltyCard: 'lc',
  promotion: 'lp',
  loyaltyTx: 'ltx',
  certificateType: 'lctt',
  certificate: 'lcert',
  membershipType: 'lmt',
  membershipSale: 'lm',
  membershipFreeze: 'lmf',
  clientAccountType: 'lat',
  clientAccount: 'la',
  clientAccountOp: 'lao',
  // этап 12 — финансы и касса: только на сервере (как этапы 5/9/11) — мок фронта хранит id операций
  // произвольными строками, поэтому префиксы свои: касса fr, статья fitem, операция fop, контрагент fcp,
  // документ fdoc, метод оплаты fpm, строка оплаты визита — уже 'pay' (этап 7)
  cashRegister: 'fr',
  paymentItem: 'fitem',
  finOp: 'fop',
  finCounterparty: 'fcp',
  financeDocument: 'fdoc',
  // этап 21, лейн finance+stock
  finRecord: 'frec',
  cashShift: 'shf',
  paymentMethod: 'fpm',
  // этап 13 — склад: только на сервере (мок хранит id произвольными строками) — склад wh, категория gcat,
  // товар gd, документ операции sop, техкарта tc, инвентаризация sinv, оборудование equ, напоминание srem
  warehouse: 'wh',
  stockCategory: 'gcat',
  product: 'gd',
  stockOp: 'sop',
  stockOpLine: 'sol',
  techCard: 'tc',
  inventory: 'sinv',
  equipment: 'equ',
  stockReminder: 'srem',
  // этап 14 — зарплата: только на сервере (мок хранит id произвольными строками, settlement — 'set') —
  // схема сотрудника pysch, правило pyrul, критерий pycri, схема расчёта (chart) pycht, назначение pyca,
  // тип премии/штрафа bpt (как newId('bpt') мока), запись взаиморасчётов pyset (мок: newId('set'))
  payrollScheme: 'pysch',
  payrollRule: 'pyrul',
  payrollCriterion: 'pycri',
  payrollChart: 'pycht',
  payrollChartAssignment: 'pyca',
  bonusPenaltyType: 'bpt',
  payrollSettlementEntry: 'pyset',
  // этап 15 — сеть: только на сервере (мок хранит id произвольными строками) — пользователь сети nu,
  // поле nf, сетевая категория товаров ngcl, рассылка nbc
  networkUser: 'nu',
  networkField: 'nf',
  networkGoodsCategoryLink: 'ngcl',
  networkBroadcast: 'nbc',
  // этап 21 (лейн network+reports) — подразделение nsd, тип нерабочего дня сети nodt
  networkSubdivision: 'nsd',
  networkOffDayType: 'nodt',
  // этап 16 — отчёты: только на сервере — выгрузка rex
  reportExport: 'rex',
  // этап 17 — интеграции: только на сервере (мок хранит id произвольными строками) — ключ/токен apik,
  // адрес вебхука wha, доставка whd, подключение каталожного приложения ic
  apiKey: 'apik',
  webhookAddress: 'wha',
  webhookDelivery: 'whd',
  integrationConnection: 'ic',
  // этап 18 — подписка, монеты, промокоды, настройки: только на сервере — списание sbc, счёт inv (как newId('inv')
  // мока), способ оплаты card, бесплатные дни fpg, промокод prm/prr, движение монет coin, объявление цены prc,
  // журнал настроек scl, обращение breq, заявка на сферу sphr, категория записи rcat (как мок)
  subscriptionCharge: 'sbc',
  billingInvoice: 'inv',
  savedCard: 'card',
  freePeriodGrant: 'fpg',
  promoCode: 'prm',
  promoRedemption: 'prr',
  coinEntry: 'coin',
  priceRuleChange: 'prc',
  settingsChangeLog: 'scl',
  bizRequest: 'breq',
  sphereRequest: 'sphr',
  recordCategory: 'rcat',
  // этап 19 — модерация и наша панель: причина отказа rr / очередь mod (как мок newId('mod')/newId('rr')),
  // наши сведения о бизнесе — без id (PK businessId), копия backup → 'bkp' (мок 'backup' длиннее 5 символов),
  // идея idea (как мок), визит нашей команды — свой префикс ovis (журнальный 'vis' уже занят MedicalVisitNote)
  rejectReason: 'rr',
  moderationItem: 'mod',
  moderationEvent: 'mev',
  backupCopy: 'bkp',
  idea: 'idea',
  salesVisit: 'ovis',
  salesVisitEvent: 'vev',
  // этап 20 — данные и удаление: личная выгрузка «мои данные» (F-15-154) — только на сервере, свой префикс
  accountDataExport: 'adex',
  // этап 19 (продолжение) — реклама/сторис/спрос/план: объявление ad (как мок newId('ad')), место сторис
  // story (мок newId('story')), достижение «первый» first (мок newId('first')); demandLead уже был (этап 9)
  ad: 'ad',
  storyBooking: 'story',
  firstAward: 'first',
  // этап 19 (попытка 3) — подключение салона за 10 минут: черновик cd (мок newId('cd')); приглашение
  // мастера внутри черновика — свой префикс cinv, не 'inv' (уже занят billingInvoice, этап 18)
  connectDraft: 'cd',
  connectInvite: 'cinv',
  // этап 21 — расписание группового события (F-16-067…077, EventSeriesDef фронта — как мок newId('evs')) и
  // расписание посещений клиента (F-16-078…080, VisitScheduleEntry — как мок newId('vsc'))
  eventSeriesDef: 'evs',
  visitScheduleEntry: 'vsc',
  // этап 21 — лист ожидания СВОЕГО экрана resources.ts (F-16-149…168) — отдельная таблица от journal
  // waitlist_entries (та — другая реализация, слоты вместо желаний, tags нет; сводить их — отдельная задача,
  // qa/requests/resources.md, домен src/domain/resources.ts), поэтому свой префикс, как мок newId('wl')
  resourcesWaitlistEntry: 'wl',
  // этап 21 (лейн services+rest) — дипломы/сертификаты мастера (F-00-088, StaffDocument фронта, мок newId('doc'));
  // хранятся в business_settings (area 'services.documents'), не своей таблицей — id всё равно должен быть уникален
  staffDocument: 'sdoc',
  // этап 21 (лейн client) — отзывы (В-24, F-14-013/014, мок newId('srv')/newId('lrv')): 'sv'/'str' заняты
  // (service, starRating), поэтому свои префиксы srev/lrev
  staffReview: 'srev',
  locationReview: 'lrev',
  // этап 21 (лейн client+online) — своё поле экрана «Данные клиента» (F-03-073, мок newId('cf'))
  customField: 'cf',
  // этап 21 (лейн client+online), попытка 2 — общая таблица мелких сущностей online (промоблок/пакет/звёздочка/
  // событие виджета/приглашение в окно/лист ожидания виджета), см. OnlineRecord в schema.prisma
  onlineRecord: 'orec',
  // этап 21 (лейн notify+integrations), попытка 3 — свой список вебхуков notify (F-05-120, мок newId('wh'));
  // 'wh' занят warehouse на сервере, поэтому свой префикс. Хранится в BusinessSetting (JSON, area
  // 'notify-webhooks'), не своя таблица — см. notify-more.service.ts.
  notifyWebhook: 'nwh',
  // этап 21 (лейн notify+integrations), попытка 3 — GA-поток install-а (F-13-080/b04, мок newId('ga'));
  // хранится в IntegrationConnection.config JSON (b03/b04 «свои» поля AppInstall, см. connections.service.ts).
  gaDataStream: 'ga',
  // этап 21 (лейн rest), попытка 2 — журнал рассылок CRM/сообщения из окна записи (F-04-038…040/100,
  // мок newId('msg')): своя таблица ClientBroadcastMessage, префикс свой ('msg' ни за кем не закреплён
  // на сервере, но короче и понятнее свой)
  clientBroadcastMessage: 'cbm',
  // этап 21 (лейн client+online), попытка 4 — визит-микрокасса (F-14-092…098): одна таблица VisitCashRecord,
  // префиксы id — те же, что у мока (client.ts::newId('vsl')/newId('vpay'))
  visitSaleLine: 'vsl',
  visitPayment: 'vpay',
  // этап 21 (лейн network+reports), попытка 3 — сетевая должность (F-11-104…106, мок newId('netpos'));
  // префикс короче мокового — ID_RE ограничивает префикс 2–5 буквами (5+1+26=32=VARCHAR(32))
  networkPositionDef: 'ntpos',
  // этап 21 (лейн network+reports), попытка 3 — архив товаров сети (F-11-118, мок newId('goodsarch'));
  // тот же 5-буквенный предел префикса
  networkGoodsArchiveEntry: 'ngar',
  // этап 21 (сдача, попытка 4) — маршрут и правило телефонии сети (мок newId('net-route')/newId('net-rule'))
  networkTelRoute: 'ntrt',
  networkTelRule: 'ntrl',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const ulid = monotonicFactory();

/** Новый id: newId('booking') → 'bk_01J9Z…' */
export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${ulid()}`;
}

const ID_RE = /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Похоже ли на id нужного вида (для проверки входа, до похода в базу). Сид-данные мока тоже проходят по префиксу. */
export function isId(value: unknown, kind?: IdKind): value is string {
  if (typeof value !== 'string' || value.length > 32) return false;
  if (kind) return value.startsWith(`${ID_PREFIX[kind]}_`) && value.length > ID_PREFIX[kind].length + 1;
  return ID_RE.test(value) || /^[a-z]{2,5}_[A-Za-z0-9_]{1,26}$/.test(value);
}
