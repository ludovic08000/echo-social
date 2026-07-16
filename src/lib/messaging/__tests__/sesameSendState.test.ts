import { describe, expect, it } from 'vitest';
import {
  aggregateSesameUiMessageStatus,
  getHighestSuccessfulRecipientStatus,
  isSesameMessageJustForMe,
  maxSesameSendStatus,
  SesameSendActionType,
  SesameSendStatus,
  sesameSendStateReducer,
  someRecipientSesameSendStatus,
  summarizeSesameSendStates,
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

  it('allows manual retry to recover a failed recipient', () => {
    const result = sesameSendStateReducer(
      { status: SesameSendStatus.Failed, updatedAt: 10 },
      { type: SesameSendActionType.ManuallyRetried, updatedAt: 20 },
    );
    expect(result).toEqual({ status: SesameSendStatus.Pending, updatedAt: 20 });
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

  it('excludes the current user from recipient predicates', () => {
    const states = {
      me: { status: SesameSendStatus.Read },
      contact: { status: SesameSendStatus.Delivered },
    } as const;
    expect(someRecipientSesameSendStatus(states, 'me', status => status === SesameSendStatus.Read)).toBe(false);
    expect(someRecipientSesameSendStatus(states, 'me', status => status === SesameSendStatus.Delivered)).toBe(true);
  });

  it('detects note-to-self messages', () => {
    expect(isSesameMessageJustForMe({ me: { status: SesameSendStatus.Sent } }, 'me')).toBe(true);
    expect(isSesameMessageJustForMe({ me: { status: SesameSendStatus.Sent }, other: { status: SesameSendStatus.Sent } }, 'me')).toBe(false);
  });

  it('returns the highest successful external recipient state', () => {
    const states = {
      me: { status: SesameSendStatus.Viewed },
      a: { status: SesameSendStatus.Sent },
      b: { status: SesameSendStatus.Delivered },
      c: { status: SesameSendStatus.Failed },
    } as const;
    expect(getHighestSuccessfulRecipientStatus(states, 'me')).toBe(SesameSendStatus.Delivered);
  });

  it('surfaces partial group failures instead of hiding them', () => {
    const states = {
      a: { status: SesameSendStatus.Delivered },
      b: { status: SesameSendStatus.Failed },
    } as const;
    expect(aggregateSesameUiMessageStatus(states)).toBe('partial-sent');
  });

  it('aggregates a fully read group message', () => {
    const states = {
      a: { status: SesameSendStatus.Read },
      b: { status: SesameSendStatus.Viewed },
    } as const;
    expect(aggregateSesameUiMessageStatus(states)).toBe('viewed');
    expect(summarizeSesameSendStates(states)).toMatchObject({ total: 2, read: 1, viewed: 1 });
  });
});
