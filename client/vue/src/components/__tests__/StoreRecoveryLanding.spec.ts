import { product } from '@workspace/core/product';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StoreRecovery } from '@workspace/core/contracts';
import StoreRecoveryLanding from '../StoreRecoveryLanding.vue';

const newer: StoreRecovery = {
  file: 'roster.json', reason: 'newer', message: 'roster.json uses schema 99',
  backup: { name: 'roster-v8-2026-11-22T15-30-00.000Z.json', createdAt: '2026-11-22T15:30:00.000Z' },
};
const mountLanding = (recovery: StoreRecovery, restore = vi.fn().mockResolvedValue(undefined), quit = vi.fn()) => ({
  wrapper: mount(StoreRecoveryLanding, { props: { recovery, restore, quit }, attachTo: document.body }), restore, quit,
});
const button = (wrapper: ReturnType<typeof mountLanding>['wrapper'], text: string) => wrapper.findAll('button').find(candidate => candidate.text() === text);

describe('StoreRecoveryLanding', () => {
  it('offers the backup, dated in local time, and warns that later work is lost', async () => {
    const { wrapper, restore } = mountLanding(newer);
    const localDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(newer.backup!.createdAt));

    expect(wrapper.text()).toContain(`newer version of ${product.name}`);
    expect(wrapper.text()).toContain(localDate);
    expect(wrapper.text()).toContain('after that time');
    await button(wrapper, 'Restore backup')!.trigger('click');
    expect(restore).toHaveBeenCalledExactlyOnceWith(newer.backup!.name);
    wrapper.unmount();
  });

  it('shows why a restore failed and lets the user try again or quit', async () => {
    const { wrapper, quit } = mountLanding(newer, vi.fn().mockRejectedValue(new Error('disk full')));

    await button(wrapper, 'Restore backup')!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('disk full');
    expect(button(wrapper, 'Restore backup')!.attributes('disabled')).toBeUndefined();
    await button(wrapper, 'Quit')!.trigger('click');
    expect(quit).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it('only asks to update or quit when there is no backup to restore', () => {
    const { wrapper } = mountLanding({ ...newer, backup: null });
    expect(button(wrapper, 'Restore backup')).toBeUndefined();
    expect(wrapper.text()).toContain(`Update ${product.name}`);
    wrapper.unmount();

    const damaged = mountLanding({ ...newer, reason: 'unreadable', message: 'settings.json is not valid JSON', file: 'settings.json', backup: null }).wrapper;
    expect(damaged.text()).toContain('settings.json is not valid JSON');
    damaged.unmount();
  });
});
