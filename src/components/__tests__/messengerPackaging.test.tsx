import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const variant = vi.hoisted(() => ({ IS_MESSENGER_APP: true }));
vi.mock('@/lib/applicationVariant', () => variant);
import { ChatWidgetProvider, useChatWidget } from '../ChatWidgetContext';
import Messages from '@/pages/Messages';

let chat: ReturnType<typeof useChatWidget>;
function Probe() { chat = useChatWidget(); return <span>{chat.state.isOpen ? 'open' : 'closed'}:{chat.state.conversationId ?? 'list'}:{String(chat.state.isMinimized)}</span>; }
describe('independent messenger uses a single existing chat runtime', () => {
  beforeEach(() => { variant.IS_MESSENGER_APP = true; });
  it('opens the existing widget without redirecting to the feed', () => {
    render(<MemoryRouter><ChatWidgetProvider><Messages /><Probe /></ChatWidgetProvider></MemoryRouter>);
    expect(screen.getByRole('main', { name: 'ForSure Messages' })).toBeTruthy();
    expect(screen.getByText('open:list:false')).toBeTruthy();
  });
  it('close returns to the list and minimize cannot leave a blank app', () => {
    render(<ChatWidgetProvider><Probe /></ChatWidgetProvider>);
    act(() => chat.openConversation('test'));
    act(() => chat.closeChat());
    expect(screen.getByText('open:list:false')).toBeTruthy();
    act(() => chat.minimizeChat());
    expect(screen.getByText('open:list:false')).toBeTruthy();
  });
  it('preserves social widget close and minimize behavior', () => {
    variant.IS_MESSENGER_APP = false;
    render(<ChatWidgetProvider><Probe /></ChatWidgetProvider>);
    act(() => chat.openChat());
    act(() => chat.minimizeChat());
    expect(screen.getByText('open:list:true')).toBeTruthy();
    act(() => chat.closeChat());
    expect(screen.getByText('closed:list:false')).toBeTruthy();
  });
});
