import { describe, expect, it } from 'vitest';
import {
  SesameSendActionType,
  SesameSendStatus,
  maxSesameSendStatus,
  sesameSendStateReducer,
  toSesameSendStatus,
} from '../sesameSendState';

describe('Sesame Signal-derived send state', () => {
  it('never moves a successful message backwards', () => {
    const delivered = { status: SesameSendStatus.Delivered, updatedAt: 100 } as const;
    const afterLateSent = sesameSendStateReducer(delivered, {
      type: SesameSendActionType.Sent,
      updatedAt: 200,
    });
    expect(afterLateSent).toBe(delivered);
  });

  it('accepts a read receipt even when delivery receipt arrives later', () => {
    const sent = { status: SesameSendStatus.Sent, updatedAt: 100 } as const;
    const read = sesameSendStateReducer(sent, {
      type: SesameSendActionType.GotReadReceipt,
      updatedAt: 200,
    });
    expect(read.status).toBe(SesameSendStatus.Read);

    const lateDelivery = sesameSendStateReducer(read, {
      type: SesameSendActionType.GotDeliveryReceipt,
      updatedAt: 300,
    });
    expect(lateDelivery.status).toBe(SesameSendStatus.Read);
  });

  it('only turns Pending into Failed', () => {
    expect(sesameSendStateReducer(
      { status: SesameSendStatus.Pending },
      { type: SesameSendActionType.Failed, updatedAt: 1 },
    ).status).toBe(SesameSendStatus.Failed);

    expect(sesameSendStateReducer(
      { status: SesameSendStatus.Delivered },
      { type: SesameSendActionType.Failed, updatedAt: 2 },
    ).status).toBe(SesameSendStatus.Delivered);
  });

  it('maps detailed Sesame queue phases to stable delivery semantics', () => {
    expect(toSesameSendStatus('encrypting')).toBe(SesameSendStatus.Pending);
    expect(toSesameSendStatus('sent')).toBe(SesameSendStatus.Sent);
    expect(toSesameSendStatus('delivered')).toBe(SesameSendStatus.Delivered);
    expect(toSesameSendStatus('read')).toBe(SesameSendStatus.Read);
    expect(toSesameSendStatus('failed_visible')).toBe(SesameSendStatus.Failed);
  });

  it('selects the highest status', () => {
    expect(maxSesameSendStatus(SesameSendStatus.Read, SesameSendStatus.Sent))
      .toBe(SesameSendStatus.Read);
  });
});
