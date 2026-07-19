import { describe, expect, it } from 'vitest';
import {
  aggregateAegisUiMessageStatus,
  getHighestSuccessfulRecipientStatus,
  isAegisMessageJustForMe,
  maxAegisSendStatus,
  AegisSendActionType,
  AegisSendStatus,
  aegisSendStateReducer,
  someRecipientAegisSendStatus,
  summarizeAegisSendStates,
  toAegisSendStatus,
} from '../aegisSendState';

describe('Aegis Signal-derived send state', () => {
  it('never moves a successful message backwards', () => {
    const delivered = { status: AegisSendStatus.Delivered, updatedAt: 100 } as const;
    const afterLateSent = aegisSendStateReducer(delivered, {
      type: AegisSendActionType.Sent,
      updatedAt: 200,
    });
    expect(afterLateSent).toBe(delivered);
  });

  it('accepts a read receipt even when delivery receipt arrives later', () => {
    const sent = { status: AegisSendStatus.Sent, updatedAt: 100 } as const;
    const read = aegisSendStateReducer(sent, {
      type: AegisSendActionType.GotReadReceipt,
      updatedAt: 200,
    });
    expect(read.status).toBe(AegisSendStatus.Read);

    const lateDelivery = aegisSendStateReducer(read, {
      type: AegisSendActionType.GotDeliveryReceipt,
      updatedAt: 300,
    });
    expect(lateDelivery.status).toBe(AegisSendStatus.Read);
  });

  it('only turns Pending into Failed', () => {
    expect(aegisSendStateReducer(
      { status: AegisSendStatus.Pending },
      { type: AegisSendActionType.Failed, updatedAt: 1 },
    ).status).toBe(AegisSendStatus.Failed);

    expect(aegisSendStateReducer(
      { status: AegisSendStatus.Delivered },
      { type: AegisSendActionType.Failed, updatedAt: 2 },
    ).status).toBe(AegisSendStatus.Delivered);
  });

  it('allows manual retry to recover a failed recipient', () => {
    const result = aegisSendStateReducer(
      { status: AegisSendStatus.Failed, updatedAt: 10 },
      { type: AegisSendActionType.ManuallyRetried, updatedAt: 20 },
    );
    expect(result).toEqual({ status: AegisSendStatus.Pending, updatedAt: 20 });
  });

  it('maps detailed Aegis queue phases to stable delivery semantics', () => {
    expect(toAegisSendStatus('encrypting')).toBe(AegisSendStatus.Pending);
    expect(toAegisSendStatus('sent')).toBe(AegisSendStatus.Sent);
    expect(toAegisSendStatus('delivered')).toBe(AegisSendStatus.Delivered);
    expect(toAegisSendStatus('read')).toBe(AegisSendStatus.Read);
    expect(toAegisSendStatus('failed_visible')).toBe(AegisSendStatus.Failed);
  });

  it('selects the highest status', () => {
    expect(maxAegisSendStatus(AegisSendStatus.Read, AegisSendStatus.Sent))
      .toBe(AegisSendStatus.Read);
  });

  it('excludes the current user from recipient predicates', () => {
    const states = {
      me: { status: AegisSendStatus.Read },
      contact: { status: AegisSendStatus.Delivered },
    } as const;
    expect(someRecipientAegisSendStatus(states, 'me', status => status === AegisSendStatus.Read)).toBe(false);
    expect(someRecipientAegisSendStatus(states, 'me', status => status === AegisSendStatus.Delivered)).toBe(true);
  });

  it('detects note-to-self messages', () => {
    expect(isAegisMessageJustForMe({ me: { status: AegisSendStatus.Sent } }, 'me')).toBe(true);
    expect(isAegisMessageJustForMe({ me: { status: AegisSendStatus.Sent }, other: { status: AegisSendStatus.Sent } }, 'me')).toBe(false);
  });

  it('returns the highest successful external recipient state', () => {
    const states = {
      me: { status: AegisSendStatus.Viewed },
      a: { status: AegisSendStatus.Sent },
      b: { status: AegisSendStatus.Delivered },
      c: { status: AegisSendStatus.Failed },
    } as const;
    expect(getHighestSuccessfulRecipientStatus(states, 'me')).toBe(AegisSendStatus.Delivered);
  });

  it('surfaces partial group failures instead of hiding them', () => {
    const states = {
      a: { status: AegisSendStatus.Delivered },
      b: { status: AegisSendStatus.Failed },
    } as const;
    expect(aggregateAegisUiMessageStatus(states)).toBe('partial-sent');
  });

  it('aggregates a fully read group message', () => {
    const states = {
      a: { status: AegisSendStatus.Read },
      b: { status: AegisSendStatus.Viewed },
    } as const;
    expect(aggregateAegisUiMessageStatus(states)).toBe('viewed');
    expect(summarizeAegisSendStates(states)).toMatchObject({ total: 2, read: 1, viewed: 1 });
  });
});
