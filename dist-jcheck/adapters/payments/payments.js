import { randomUUID } from 'node:crypto';
export class FakePaymentProvider {
    constructor() {
        this.kind = 'fake';
    }
    async charge() {
        return { providerRef: `fake_${randomUUID()}`, status: 'succeeded' };
    }
}
//# sourceMappingURL=payments.js.map