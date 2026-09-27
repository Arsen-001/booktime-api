import { logger } from '../../common/logging/logger.js';

/**
 * Отправка кода входа (PLAN.md Р14, docs/backend/05 §6). Настоящий Telegram Gateway подключает этап 2;
 * WhatsApp и SMS — заглушки, пока не выбран провайдер (E7).
 */
export type CodeChannel = 'telegram' | 'whatsapp' | 'sms';

export interface CodeSender {
  readonly channel: CodeChannel;
  /** Отправить готовый текст с кодом на номер +374… */
  send(phone: string, text: string): Promise<void>;
}

/** Заглушка: пишет в лог (номер маскируется, код — нет: это только для разработки) */
export class FakeCodeSender implements CodeSender {
  constructor(readonly channel: CodeChannel) {}
  async send(phone: string, text: string): Promise<void> {
    logger.info({ channel: this.channel, phone: `${phone.slice(0, 6)}•••${phone.slice(-2)}` }, `[fake code-sender] ${text}`);
  }
}
