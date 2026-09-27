// @ts-nocheck — СГЕНЕРИРОВАНО scripts/sync-loyalty-port.mjs из booking-platform/src/domain/core.ts; руками не править.
// Типы проверяет tsc фронта (noUncheckedIndexedAccess у фронта выключен, у сервера включён — отсюда nocheck).
/**
 * Типы ЯДРА — общие для всех разделов. Этот файл принадлежит фундаменту: разделы его НЕ правят.
 * Нужно поле в ядре — просьба в qa/requests/<area>.md. Свои данные раздел хранит в своём срезе
 * (src/mock/slices/<area>.ts) с ключом по id сущности ядра (например, loyalty: карты по clientId).
 *
 * Соглашения:
 *  - id — строка с префиксом сущности (biz_, loc_, st_, sv_, cl_, bk_ …);
 *  - деньги — целые драмы (AMD), тип Money;
 *  - дата — 'YYYY-MM-DD', дата-время — 'YYYY-MM-DDTHH:mm' по местному времени Еревана (без пояса);
 *  - телефон — '+374XXXXXXXX' (8 цифр после 374), показывать через useFormat().phone.
 */

export type Id = string;
/** 'YYYY-MM-DD' */
export type ISODate = string;
/** 'YYYY-MM-DDTHH:mm' — местное время Еревана */
export type ISODateTime = string;
/** 'HH:mm' */
export type TimeHM = string;
/** Целые драмы */
export type Money = number;
export type Minutes = number;

export type LocaleCode = 'ru' | 'hy' | 'en';
/** Текст на трёх языках; ru обязателен, остальные — если есть (иначе показываем ru). */
export interface LocalizedText {
  ru: string;
  hy?: string;
  en?: string;
}

// ─────────────────────────── Сферы и районы ───────────────────────────

export type SphereId =
  | 'nails'
  | 'barber'
  | 'hair'
  | 'cosmetology'
  | 'massage'
  | 'dental'
  | 'fitness'
  | 'carwash'
  | 'general';

/** Районы Еревана (административные) */
export type DistrictId =
  | 'kentron'
  | 'arabkir'
  | 'davtashen'
  | 'malatia-sebastia'
  | 'nor-nork'
  | 'achapnyak'
  | 'shengavit'
  | 'avan'
  | 'erebuni'
  | 'kanaker-zeytun'
  | 'nork-marash'
  | 'nubarashen';

export interface GeoPoint {
  lat: number;
  lng: number;
}

// ─────────────────────────── Бизнес, сеть, филиал ───────────────────────────

export type BusinessKind = 'individual' | 'salon';
export type BusinessStatus = 'active' | 'frozen' | 'moderation' | 'draft';

export interface Business {
  id: Id;
  kind: BusinessKind;
  name: string;
  /** Адрес публичной страницы: /b/<slug> */
  slug: string;
  sphereIds: SphereId[];
  /** Если бизнес — филиал сети */
  networkId?: Id;
  ownerStaffId: Id;
  locationIds: Id[];
  phone: string;
  description?: LocalizedText;
  logoUrl?: string;
  /** Фото страницы салона (F-00-087), до 6 */
  photos: string[];
  status: BusinessStatus;
  createdAt: ISODateTime;
  /** Запрет домашних записей мастерам в часы смены (F-00-047) */
  forbidHomeBookingsDuringShift?: boolean;
  /** Сайт и соцсети на карточке места (F-14-028); заполняет раздел online («Бренд/Контакты», F-03-044) */
  socials?: SocialLinks;
  /**
   * Правила отмены и переноса (F-03-066/067, F-00-098) — ЕДИНЫЙ источник для приложения, виджета и журнала;
   * заполняет раздел online. Нет поля — DEFAULT_BOOKING_RULES (src/domain/rules/booking-policy.ts).
   * У мастера может быть своё правило — Staff.bookingRules (важнее бизнеса, F-00-066). Читать только через
   * effectiveBookingRules(business, staff).
   */
  bookingRules?: BookingRules;
  /**
   * Название бренда для клиентов — имя отправителя уведомлений (F-05-012); пишет settings. Нет поля или пусто —
   * показывать Business.name.
   */
  brandName?: string;
}

export interface SocialLinks {
  /** Полный адрес, 'https://…' */
  website?: string;
  /** Имя без @ */
  instagram?: string;
  /** Адрес страницы или имя */
  facebook?: string;
  /** Писать в WhatsApp на Business.phone (устарело — используйте whatsappNumber, F-15-108) */
  whatsapp?: boolean;
  /** Номер WhatsApp без «+», пробелов и скобок — wa.me/<номер> (F-15-108); пишет settings */
  whatsappNumber?: string;
  /** Ссылка вида https://t.me/username (F-15-108); пишет settings */
  telegramUrl?: string;
  /** Номер Viber (F-15-108); пишет settings */
  viberNumber?: string;
}

export interface BookingRules {
  /** Может ли клиент сам отменять онлайн (F-03-067). Нет поля — может */
  allowCancel?: boolean;
  /** Может ли клиент сам переносить онлайн (F-03-066). Нет поля — может */
  allowReschedule?: boolean;
  /**
   * Срок БЕСПЛАТНОЙ отмены: за сколько минут до начала (шаг 15 мин). Отменить позже срока клиент тоже может,
   * но это засчитывается как неявка (F-00-098, решено) — см. clientCancelOutcome().
   */
  cancelWindowMin?: Minutes;
  /** За сколько минут до начала клиент ещё может перенести сам (шаг 15 мин) */
  rescheduleWindowMin?: Minutes;
  /** Разрешить отменять онлайн записи с внесённой предоплатой */
  allowCancelPrepaid?: boolean;
  /** Разрешить переносить онлайн записи с внесённой предоплатой */
  allowReschedulePrepaid?: boolean;
}

export interface Network {
  id: Id;
  name: string;
  ownerStaffId: Id;
  businessIds: Id[];
  createdAt: ISODateTime;
  /**
   * Главная локация сети (F-05-118): с её баланса и тарифа идут сетевые рассылки; пишет network.
   * Нет поля — первая из businessIds.
   */
  mainBusinessId?: Id;
}

export interface Location {
  id: Id;
  businessId: Id;
  /** Название филиала/места (показывать через pickText) */
  name: LocalizedText;
  /** Адрес на трёх языках (армянский — целиком, F-00-172) */
  address: LocalizedText;
  district: DistrictId;
  /** Просто ссылка, в коде карту не рисуем (F-00-074) */
  yandexMapsUrl?: string;
  /** Точка из кнопки «Я сейчас на месте работы» (F-00-075) */
  coords?: GeoPoint;
  phone?: string;
  /** Дополнительные телефоны кроме основного (F-15-106) — первый (phone) остаётся главным для кнопки связи */
  extraPhones?: string[];
  /** Часы работы текстом для клиентов (F-15-105), например «пн–пт, 09:00–22:00» — не связано с графиком сотрудников */
  hoursText?: string;
  /** Часы работы филиала (для витрины); рабочее время мастеров — в WorkSchedule */
  openHours?: WeekTemplate;
  /** Тип журнала филиала (F-01-025): только записи / записи и события / только события. Нет — 'individual' */
  journalKind?: JournalKind;
  /**
   * Часовой пояс филиала, IANA (F-02-074); пишет settings. Нет поля — 'Asia/Yerevan'. Даты-время В ДАННЫХ остаются
   * местным временем Еревана (все филиалы — в Армении); поле — для настройки и показа, пересчёт окон по нему не делаем.
   */
  timezone?: string;
}

export type JournalKind = 'individual' | 'mixed' | 'group';

// ─────────────────────────── Сотрудники ───────────────────────────

export type StaffRole = 'owner' | 'admin' | 'master';
export type StaffStatus = 'active' | 'invited' | 'disabled' | 'fired';
/** Места работы (F-00-073) */
export type Workplace = 'salon' | 'home' | 'visit' | 'gym' | 'online';
/** Кого принимает (F-00-069) */
export type AcceptsWhom = 'all' | 'women' | 'men';
/** Кто видит календарь мастера (F-00-065) */
export type CalendarVisibility = 'all' | 'link' | 'mine';
/** Режим календаря (F-00-051): «всё свободно — отмечаю занятое» / «всё занято — открываю свободное» */
export type CalendarMode = 'free' | 'busy';
/** Подтверждение записи (F-00-067) */
export type ConfirmMode = 'instant' | 'manual';

export interface Staff {
  id: Id;
  businessId: Id;
  /** В каких филиалах работает */
  locationIds: Id[];
  name: string;
  phone: string;
  /** Почта сотрудника (F-01-008: имя и email внизу панели; F-10-* карточка); пишет staff. Нет — строку не показывать */
  email?: string;
  role: StaffRole;
  /** Должность, например «Мастер маникюра» */
  position?: LocalizedText;
  /** Специализация — короткая метка «Ногтевой сервис», отдельно от должности (F-03-017); пишет staff. Нет — показывать position */
  specialty?: LocalizedText;
  sphereIds: SphereId[];
  avatarUrl?: string;
  bio?: LocalizedText;
  /** Фото работ, до 6 (F-00-085) */
  photos: string[];
  /** Материалы, которыми работает (F-00-089) */
  materials: string[];
  workplaces: Workplace[];
  /** Адрес «дома» (F-00-077) — клиенту только после подтверждённой записи */
  homeAddress?: string;
  homeDistrict?: DistrictId;
  /** Районы выезда (F-00-080) */
  visitDistricts?: DistrictId[];
  accepts: AcceptsWhom;
  calendarVisibility: CalendarVisibility;
  calendarMode: CalendarMode;
  confirmMode: ConfirmMode;
  /** Индекс цвета в журнале: 1..8 → токены chart-1..chart-8 */
  colorIndex: number;
  serviceIds: Id[];
  status: StaffStatus;
  /** Логин администратора (F-00-034) */
  login?: string;
  /** Часы для звонков (F-00-105) */
  callHours?: { from: TimeHM; to: TimeHM };
  hiredAt: ISODate;
  /** Можно ли записаться к мастеру онлайн (F-03-134). Нет поля — можно (true) */
  onlineBookingEnabled?: boolean;
  /** Не показывать колонку сотрудника в журнале (F-01-019), график не трогается */
  hiddenInJournal?: boolean;
  /**
   * F-09-044: заведён как отдельный ассистент («Только просмотр», без своих услуг и без графика) — не
   * оказывает услуг сам, участвует в записях только как помощник. Бесплатное место подписки — в отличие
   * от `hiddenInJournal`, который может стоять и у обычного платного мастера.
   */
  assistantOnly?: boolean;
  /** Шаг линий разметки сетки журнала у этого сотрудника, мин (F-01-021). Нет — без разметки */
  journalMarkupMin?: 15 | 30 | 60 | 90 | 120;
  /** Ручная предоплата мастера (F-00-097): нет поля — предоплата не нужна */
  prepayment?: PrepaymentRule;
  /** Свои правила отмены/переноса мастера (F-00-066) — важнее Business.bookingRules; пишет online */
  bookingRules?: BookingRules;
  /**
   * Каналы связи и режим звонка (F-00-104, F-00-105); хозяин — раздел staff (черновик сейчас в срезе client).
   * Нет поля — только «Написать» через приложение, номер клиенту не отдаётся.
   */
  contacts?: StaffContactChannels;
  /**
   * Когда уволен (F-10-044, F-14-118) — только у `status === 'fired'`. Стадия 21 (лейн client+online):
   * добавлено, чтобы `canRestoreStaff` (client.ts) считал 30-дневное окно восстановления в api-режиме тем же
   * способом, что и мок (`readArea('client').staffFiredAt`), не заводя вторую копию отметки на сервере —
   * `Staff.firedAt` там уже есть (раздел staff, F-10-044).
   */
  firedAt?: ISODateTime;
}

/** Каналы связи мастера для клиента (F-00-104) и когда можно звонить (F-00-105) */
export interface StaffContactChannels {
  /** WhatsApp на Staff.phone */
  whatsapp?: boolean;
  /** Имя в Telegram без @ */
  telegram?: string;
  /** Имя в Instagram без @ */
  instagram?: string;
  /** «всегда» / «по часам» (Staff.callHours) / «не во время записей» / «только сообщения» */
  callMode?: 'always' | 'hours' | 'busy' | 'messages';
}

/** Правило ручной предоплаты по реквизитам (F-00-097) — по всем услугам мастера */
export interface PrepaymentRule {
  amount: Money;
  /** Сколько минут держится окно, пока клиент не нажал «Я оплатил» */
  timeoutMin: Minutes;
  /** Реквизиты, например «Idram · +374 …» */
  requisites: string;
}

// ─────────────────────────── Услуги ───────────────────────────

export interface ServiceCategory {
  id: Id;
  businessId: Id;
  name: LocalizedText;
  order: number;
}

export type ServiceKind = 'individual' | 'group';

export interface Service {
  id: Id;
  businessId: Id;
  categoryId: Id;
  sphereId: SphereId;
  name: LocalizedText;
  description?: LocalizedText;
  kind: ServiceKind;
  /** Длительность «от–до» (F-00-057); если max не задан — фиксированная */
  durationMin: Minutes;
  durationMax?: Minutes;
  /** Цена «от–до»; если max не задан — фиксированная */
  priceMin: Money;
  priceMax?: Money;
  /** Запас после услуги (уборка, стерилизация) */
  bufferAfterMin?: Minutes;
  /** Интервал «пора снова», дней (F-00-084) */
  repeatIntervalDays?: number;
  /**
   * Напоминание о повторном визите по этой услуге (F-05-037); пишет services, читает notify. Нет поля — общие настройки
   * локации (notify); 'off' — не отправлять после этой услуги; 'custom' — через repeatIntervalDays дней.
   */
  winbackReminder?: 'off' | 'custom';
  /** Для групповых — мест в событии */
  capacity?: number;
  photos: string[];
  materials: string[];
  staffIds: Id[];
  /** Где оказывается */
  workplaces: Workplace[];
  onlineBookable: boolean;
  active: boolean;
  order: number;
  /** Выбор оттенка/варианта при записи (F-00-094…096): обязательно / желательно; нет поля — шага выбора нет */
  shadeChoice?: 'required' | 'preferred';
  /**
   * Пакет (комплекс) услуг (F-01-134…136, F-03-130): услуга продаётся как набор из 2–10 услуг. Хозяин — services;
   * журнал и онлайн-запись только читают. Нет поля — обычная услуга. kind остаётся 'individual'; длительность и цена
   * самой услуги-пакета — итог по составу (считает тот, кто сохраняет пакет).
   */
  servicePackage?: ServicePackage;
}

/** Состав и вид пакета услуг */
export interface ServicePackage {
  /** Входящие услуги по порядку оказания */
  items: { serviceId: Id; order: number }[];
  /** Одновременно разными мастерами / последовательно одним мастером / последовательно несколькими */
  mode: 'parallel' | 'sequentialSame' | 'sequentialAny';
}

// ─────────────────────────── Ресурсы ───────────────────────────

export type ResourceKind =
  'chair' | 'room' | 'device' | 'box' | 'hall' | 'other';

export interface Resource {
  id: Id;
  businessId: Id;
  locationId: Id;
  name: LocalizedText;
  kind: ResourceKind;
  /** Экземпляры: «Кресло 1», «Кресло 2» */
  instances: { id: Id; name: string }[];
  serviceIds: Id[];
  active: boolean;
}

// ─────────────────────────── Клиенты ───────────────────────────

export type Gender = 'female' | 'male' | 'unknown';

/** Клиент в базе КОНКРЕТНОГО бизнеса. Ключ — телефон (уникален в пределах businessId). */
export interface Client {
  id: Id;
  businessId: Id;
  phone: string;
  name: string;
  gender: Gender;
  birthday?: ISODate;
  email?: string;
  note?: string;
  tags: string[];
  /** Если этот номер есть в приложении клиента */
  appUserId?: Id;
  /** Число неявок (F-00-071) — меняют только функции ядра (changeBookingStatus, отмена позже срока) */
  noShowCount: number;
  blocked?: boolean;
  createdAt: ISODateTime;
  /** Мягкое удаление карточки (F-04-074): записи остаются с этим clientId; в списках не показывать */
  deletedAt?: ISODateTime;
}

/** Пользователь приложения клиента. Чужие CRM-данные ему не видны (F-00-130). */
export interface AppUser {
  id: Id;
  phone: string;
  name: string;
  gender: Gender;
  birthday?: ISODate;
  district?: DistrictId;
  locale: LocaleCode;
  createdAt: ISODateTime;
  /** Фото профиля клиента (F-14-059), data URL как у Staff.avatarUrl; пишет client. Нет — инициалы */
  photoUrl?: string;
}

// ─────────────────────────── Записи ───────────────────────────

/**
 * Статусы записи (F-00-068 + 1:1 Altegio):
 *  awaiting_confirmation — ждёт подтверждения мастера;
 *  awaiting_prepayment — ждёт предоплату;
 *  scheduled — подтверждена, ожидаем клиента;
 *  client_confirmed — клиент подтвердил;
 *  arrived — пришёл;  no_show — не пришёл;
 *  cancelled_by_client / cancelled_by_master — отменена.
 */
export type BookingStatus =
  | 'awaiting_confirmation'
  | 'awaiting_prepayment'
  | 'scheduled'
  | 'client_confirmed'
  | 'arrived'
  | 'no_show'
  | 'cancelled_by_client'
  | 'cancelled_by_master';

/** Откуда пришла запись (F-01-098) */
export type BookingSource =
  'journal' | 'app' | 'link' | 'widget' | 'phone' | 'import' | 'external';

/** Для кого запись (F-00-125) */
export type BookingForWhom = 'self' | 'child' | 'pet' | 'other';

export interface BookingServiceLine {
  serviceId: Id;
  staffId: Id;
  /** Цена за единицу ПОСЛЕ скидки (итог строки = price × qty). Собирать строку — makeServiceLine() (rules/pricing) */
  price: Money;
  durationMin: Minutes;
  qty: number;
  /** Цена за единицу ДО скидки; нет поля — скидки нет, price и есть цена */
  unitPrice?: Money;
  /** Скидка на строку, % 0–100 (F-06-184); нет поля — 0 */
  discountPct?: number;
  /**
   * Ресурс, занятый ТОЛЬКО на время этой строки (F-01-132 «Разделение записи по ресурсам»); ставит вклад resources
   * в окне записи. Нет поля — строка занимает ресурсы всей записи (Booking.resourceIds).
   */
  resourceId?: Id;
}

export interface Booking {
  id: Id;
  businessId: Id;
  locationId: Id;
  /** Главный мастер записи */
  staffId: Id;
  /** Пусто — «запись без клиента» (F-01-039) */
  clientId?: Id;
  appUserId?: Id;
  /** Начало, 'YYYY-MM-DDTHH:mm' */
  start: ISODateTime;
  durationMin: Minutes;
  status: BookingStatus;
  services: BookingServiceLine[];
  /** Сумма по услугам, драм */
  total: Money;
  resourceIds: Id[];
  workplace: Workplace;
  source: BookingSource;
  /** Кто создал: id сотрудника или 'client' */
  createdBy: Id | 'client';
  forWhom: BookingForWhom;
  /** «Записывает другого посетителя» (F-01-127) */
  visitorName?: string;
  comment?: string;
  /** Предоплата по реквизитам (F-00-097); holdUntil — до какого момента окно держится без «Я оплатил» */
  prepayment?: { amount: Money; paid: boolean; holdUntil?: ISODateTime };
  /** Клиент отменил позже срока бесплатной отмены — засчитано как неявка (F-00-098); ставит ядро */
  cancelledLate?: boolean;
  /**
   * Почему отменена, если это сделал не человек: 'prepayment_expired' — предоплата не пришла в срок, ядро сняло запись
   * (releaseExpiredPrepayments). Клиенту — «Снята: предоплата не поступила вовремя» (common.bookingCancelReason.*), а не
   * «Отменена вами». Нет поля — отменил тот, кто указан в статусе.
   */
  cancelReason?: 'prepayment_expired' | 'confirmation_expired';
  /**
   * В-03: до какого момента мастер отвечает на заявку «ждёт подтверждения» — 2 ч с создания, но не позже чем за час до
   * начала; молчание → заявка снимается (ставит сервер). Нет поля — считается по тому же правилу (confirmDeadlineOf).
   */
  confirmDeadline?: ISODateTime;
  /** Участник группового события */
  groupEventId?: Id;
  /** Серия повторов (F-01-100) */
  seriesId?: Id;
  /** Несколько записей клиента за день = один визит (F-01-041) */
  visitId?: Id;
  /**
   * Системная метка записи (F-01-028): 'specific' — «Только этот специалист» (клиент сам выбрал мастера),
   * 'any' — «Любой сотрудник» (клиент пропустил выбор). Ставит тот, кто создаёт запись онлайн; нет поля — не важно.
   */
  staffAssignment?: 'specific' | 'any';
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /** Мягкое удаление (F-01-119) */
  deletedAt?: ISODateTime;
}

export interface GroupEvent {
  id: Id;
  businessId: Id;
  locationId: Id;
  serviceId: Id;
  staffId: Id;
  start: ISODateTime;
  durationMin: Minutes;
  capacity: number;
  resourceIds: Id[];
  /** Онлайн-занятие — ссылка (F-00-081) */
  onlineUrl?: string;
  seriesId?: Id;
  status: 'scheduled' | 'cancelled';
  createdAt: ISODateTime;
}

// ─────────────────────────── График ───────────────────────────

export interface TimeRange {
  from: TimeHM;
  to: TimeHM;
}

/** Рабочие интервалы дня; пустой массив — выходной. Перерывы — промежутки между интервалами. */
export type DayHours = TimeRange[];

/** Шаблон недели: 0 = понедельник … 6 = воскресенье */
export type WeekTemplate = Record<0 | 1 | 2 | 3 | 4 | 5 | 6, DayHours>;

export interface WorkSchedule {
  id: Id;
  staffId: Id;
  locationId: Id;
  /** Где работает по этому графику */
  workplace: Workplace;
  week: WeekTemplate;
  /** Исключения на даты: пустой массив — выходной в этот день */
  overrides: Record<ISODate, DayHours>;
  /** До какой даты открыт график (F-00-055) */
  openUntil?: ISODate;
}

/**
 * Отметки в календаре мастера для двух режимов (F-00-051):
 *  kind 'busy' — «занято» в режиме «всё свободно»;
 *  kind 'free' — «открыто» в режиме «всё занято».
 */
export interface CalendarMark {
  id: Id;
  staffId: Id;
  date: ISODate;
  from: TimeHM;
  to: TimeHM;
  kind: 'busy' | 'free';
  workplace?: Workplace;
  note?: string;
}

// ─────────────────────────── Журнал событий записей ───────────────────────────

/**
 * Что случилось с записью (e2e-q1 №3, F-00-101, F-04-156). Пишет ТОЛЬКО ядро (src/api/core.ts) при любой записи
 * в bookings; разделы читают listBookingEvents() — уведомления (notify), лист ожидания (resources/client),
 * «колокольчик». Хранятся последние ~1000 событий.
 *  created — запись создана;  status — сменился статус (from → to);  moved — сменились время/мастер;
 *  deleted — мягко удалена;  delayed — мастер задерживается к этой записи (F-00-059, reportBookingDelay), delayMin.
 */
export type BookingEventKind =
  'created' | 'status' | 'moved' | 'deleted' | 'delayed';

export interface BookingEvent {
  id: Id;
  bookingId: Id;
  businessId: Id;
  staffId: Id;
  clientId?: Id;
  appUserId?: Id;
  kind: BookingEventKind;
  /** Статус до и после (kind 'status'; у 'created' — только to) */
  from?: BookingStatus;
  to?: BookingStatus;
  /** Прежние время и мастер (kind 'moved') */
  prevStart?: ISODateTime;
  prevStaffId?: Id;
  /**
   * Освободившееся время (отмена, удаление, перенос, снятая просроченная предоплата) — сигнал «окно освободилось»
   * для листа ожидания (F-00-101). Нет поля — время не освобождалось.
   */
  freed?: {
    staffId: Id;
    locationId: Id;
    start: ISODateTime;
    durationMin: Minutes;
  };
  /** Кто: id сотрудника, 'client' или 'system' (снятие по сроку) */
  by: Id | 'client' | 'system';
  /** Отмена позже срока (засчитана неявка) */
  late?: boolean;
  /** Снята системой: предоплата не пришла в срок (как Booking.cancelReason) */
  reason?: 'prepayment_expired' | 'confirmation_expired';
  /** На сколько минут задерживается мастер (kind 'delayed') */
  delayMin?: Minutes;
  /**
   * Время визита ПОСЛЕ события (e2e-q3 №4): строка «Отмена · чт, 26 сент 15:00» без чтения самой записи. У 'moved' — новое
   * время (прежнее — prevStart). Нет поля (события до k4) — брать из записи.
   */
  start?: ISODateTime;
  at: ISODateTime;
}

// ─────────────────────────── Монеты бизнеса ───────────────────────────

/**
 * Движение монет бизнеса (e2e-q3 №3, F-00-145…154): ОДИН журнал на всех — покупки сторис и новостей (client),
 * подарки и возвраты модерации (platform), пополнение и история (settings, /biz/coins). Баланс = сумма amount.
 * Писать только coreTx.chargeCoins / coreTx.grantCoins (@/api/core), читать getCoinBalance / listCoinMoves.
 */
export interface CoinMove {
  id: Id;
  businessId: Id;
  /** Монеты: + на баланс, − списано */
  amount: number;
  /** topup — пополнение; charge — списание за покупку; refund — возврат; gift — подарок/бонус от платформы */
  kind: 'topup' | 'charge' | 'refund' | 'gift';
  /** Зачем, код без пробелов: 'storyPlace', 'newsExtra', 'moderationReject', 'firstAward', 'promo', 'opening'…; подпись — у читателя */
  reason: string;
  /** Раздел, сделавший движение: 'client', 'platform', 'settings'… */
  area: string;
  /** К чему относится: id места сторис, заявки модерации, покупки */
  refId?: Id;
  /** Кто: id сотрудника или 'system' (наша панель, автоматика) */
  by: Id | 'system';
  at: ISODateTime;
}

// ─────────────────────────── Операции с данными ───────────────────────────

/**
 * Общий журнал «Операции с данными» (F-04-126, F-04-130, F-04-206, F-01-182/183): импорт, выгрузка, массовое удаление —
 * кто, когда, что и сколько. Пишет раздел, делающий операцию, через logDataOperation / coreTx.logDataOperation
 * (@/api/core); показывает settings/reports через listDataOperations. Хранятся последние ~500.
 */
export interface DataOperation {
  id: Id;
  businessId: Id;
  kind: 'import' | 'export' | 'delete';
  /** Раздел, сделавший операцию: 'clients', 'journal', 'stock'… */
  area: string;
  /** Что: 'clients', 'bookings', 'products'… (подпись — словарь раздела-читателя) */
  entity: string;
  /** Сколько строк/записей */
  count: number;
  /** Сколько строк не прошло (импорт) */
  failed?: number;
  /** Имя файла, если был */
  fileName?: string;
  /** Кто: id сотрудника или 'system' */
  by: Id | 'system';
  at: ISODateTime;
}

// ─────────────────────────── Сборка ───────────────────────────

/** Все коллекции ядра в моковой базе. */
export interface CoreData {
  networks: Network[];
  businesses: Business[];
  locations: Location[];
  staff: Staff[];
  serviceCategories: ServiceCategory[];
  services: Service[];
  resources: Resource[];
  clients: Client[];
  appUsers: AppUser[];
  bookings: Booking[];
  groupEvents: GroupEvent[];
  schedules: WorkSchedule[];
  calendarMarks: CalendarMark[];
  /** Журнал событий записей — пишет только ядро, читать listBookingEvents(). Нет поля (старая база) — пусто */
  bookingEvents?: BookingEvent[];
  /** Журнал «Операции с данными» — пишет logDataOperation(), читать listDataOperations(). Нет поля — пусто */
  dataOps?: DataOperation[];
  /** Журнал монет бизнесов — пишут coreTx.chargeCoins/grantCoins, читать getCoinBalance()/listCoinMoves(). Нет поля — пусто */
  coinLedger?: CoinMove[];
}

/** Коллекции ядра с общим CRUD (coreList/coreGet/…); журналы событий, операций и монет пишут только функции ядра */
export type CoreCollection = Exclude<
  keyof CoreData,
  'bookingEvents' | 'dataOps' | 'coinLedger'
>;
export type CoreEntity<C extends CoreCollection> = CoreData[C][number];
