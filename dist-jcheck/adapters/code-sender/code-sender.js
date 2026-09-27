import { logger } from '../../common/logging/logger.js';
function maskPhone(phone) {
    return `${phone.slice(0, 6)}•••${phone.slice(-2)}`;
}
/** Заглушка: пишет в лог (номер маскируется, код — нет: заглушка стоит только там, где нет провайдера) */
export class FakeCodeSender {
    constructor(channel) {
        this.channel = channel;
        this.real = false;
    }
    async send({ phone, text }) {
        logger.info({ channel: this.channel, phone: maskPhone(phone) }, `[fake code-sender] ${text}`);
        return {};
    }
}
/**
 * Telegram Gateway API (https://core.telegram.org/gateway/api): sendVerificationMessage с нашим кодом.
 * Код генерирует и проверяет наш сервер (хэш в otp_requests), Telegram только доставляет.
 */
export class TelegramGatewaySender {
    constructor(token, baseUrl = 'https://gatewayapi.telegram.org') {
        this.token = token;
        this.baseUrl = baseUrl;
        this.channel = 'telegram';
        this.real = true;
    }
    async send({ phone, code, ttlSec }) {
        const res = await fetch(`${this.baseUrl}/sendVerificationMessage`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone_number: phone, code, ttl: ttlSec }),
            signal: AbortSignal.timeout(10_000),
        });
        const body = (await res.json().catch(() => ({})));
        if (!res.ok || !body.ok) {
            logger.warn({ phone: maskPhone(phone), status: res.status, error: body.error }, 'telegram gateway: not sent');
            throw new Error(`Telegram Gateway: ${body.error ?? res.status}`);
        }
        return { providerMessageId: body.result?.request_id };
    }
}
//# sourceMappingURL=code-sender.js.map