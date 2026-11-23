<template>
  <OnboardingLandingFrame class="store-recovery" layout="centered" :label="title">
    <div class="store-recovery__content">
      <img class="store-recovery__mark" :src="appIconUrl" :alt="product.name">
      <h1 class="onboarding-landing-title store-recovery__title">{{ title }}</h1>
      <template v-if="recovery.backup">
        <p class="store-recovery__body">{{ t('storeRecovery.backupAvailable', { date: backupDate }) }}</p>
        <p class="store-recovery__warning">{{ t('storeRecovery.laterWorkLost') }}</p>
      </template>
      <p v-else class="store-recovery__body">
        {{ recovery.reason === 'newer' ? t('storeRecovery.update', { product: product.name }) : t('storeRecovery.noBackup') }}
      </p>
      <p v-if="recovery.reason === 'unreadable'" class="store-recovery__detail">{{ recovery.message }}</p>
      <p v-if="error" class="store-recovery__error" role="alert">{{ error }}</p>
      <div class="store-recovery__actions">
        <button class="app-button app-button--large app-button--secondary agent-ui-interactive" type="button" :disabled="restoring" @click="quit">
          {{ t('storeRecovery.quit') }}
        </button>
        <button
          v-if="recovery.backup"
          class="app-button app-button--large app-button--primary agent-ui-interactive"
          data-variant="primary"
          data-appearance="solid"
          type="button"
          :disabled="restoring"
          @click="restoreBackup"
        >
          {{ restoring ? t('storeRecovery.restoring') : t('storeRecovery.restore') }}
        </button>
      </div>
    </div>
  </OnboardingLandingFrame>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { product } from '@workspace/core/product';
import type { StoreRecovery } from '@workspace/core/contracts';
import OnboardingLandingFrame from './OnboardingLandingFrame.vue';

const appIconUrl = new URL('../../assets/icon.png', import.meta.url).href;

const props = defineProps<{
  recovery: StoreRecovery;
  restore: (backup: string) => Promise<void>;
  quit: () => void;
}>();

const { t } = useI18n();
const restoring = ref(false);
const error = ref('');

const title = computed(() => props.recovery.reason === 'newer'
  ? t('storeRecovery.newerTitle', { product: product.name })
  : t('storeRecovery.unreadableTitle', { product: product.name }));
// The backup is named in UTC; the user reads it in their own time zone.
const backupDate = computed(() => props.recovery.backup
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(props.recovery.backup.createdAt))
  : '');

async function restoreBackup(): Promise<void> {
  if (!props.recovery.backup) return;
  restoring.value = true;
  error.value = '';
  try {
    await props.restore(props.recovery.backup.name);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    restoring.value = false;
  }
}
</script>

<style scoped>
.store-recovery__content {
  display: flex;
  width: min(760px, 100%);
  flex-direction: column;
  align-items: center;
  text-align: center;
}

/* The same size as on the loading screen it replaces. */
.store-recovery__mark {
  width: 128px;
  height: 128px;
  margin-bottom: var(--space-12);
}

/* The frame gives its headline a large top margin and none below; this screen balances it around the title. */
.store-recovery .store-recovery__content .store-recovery__title {
  margin: 0 0 var(--space-10);
  font-size: 36px;
  line-height: 1.05;
}

.store-recovery__body,
.store-recovery__warning,
.store-recovery__detail,
.store-recovery__error {
  margin: 0;
  font-size: var(--font-size-18);
  line-height: 1.5;
}

.store-recovery__body {
  color: var(--color-text);
}

.store-recovery__warning,
.store-recovery__detail {
  color: var(--color-text-muted);
}

.store-recovery__warning {
  margin-top: var(--space-3);
}

.store-recovery__detail {
  margin-top: var(--space-4);
  font-size: var(--font-size-14);
}

.store-recovery__error {
  margin-top: var(--space-6);
  color: var(--color-error);
}

/* The frame drags the window: its controls must not. */
.store-recovery__actions {
  display: flex;
  gap: var(--space-8);
  margin-top: var(--space-12);
  -webkit-app-region: no-drag;
}
</style>
