<template>
  <section class="subagent-panel" :aria-label="t('chat.subagents.detailsLabel')">
    <div class="subagent-panel__conversation">
      <div v-if="loading" class="subagent-panel__state">{{ t('chat.subagents.loadingConversation') }}</div>
      <div v-else-if="error" class="subagent-panel__state subagent-panel__state--error">
        <span>{{ t('chat.subagents.loadError') }}</span>
        <button data-variant="primary"
          class="app-button app-button--secondary agent-ui-interactive"
          data-testid="subagent-conversation-retry"
          type="button"
          @click="refreshMessages()"
        >
          {{ t('chat.subagents.retryConversation') }}
        </button>
      </div>
      <MessageList
        v-else
        :messages="messages"
        :busy="childWorking"
        :active-turn-id="childWorking ? messages.at(-1)?.turnId : undefined"
        :tool-visibility="isAppToolVisible"
        :reset-key="conversationId"
        :actions-disabled="true"
        :can-delete-message="false"
        :can-edit-message="false"
        :can-fork-turn="false"
        :can-retry-message="false"
        :follow-ups-disabled="true"
        :aria-label="t('chat.subagents.conversationLabel')"
        :empty-label="t('chat.subagents.emptyConversation')"
        @open-link="emit('open-link', $event)"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { MessageList, type ConversationLink } from '@korus-dev/agent-ui-sdk';
import { useI18n } from 'vue-i18n';
import type { Agent, AgentSubagentTree, RendererMessage } from '@workspace/core/contracts';
import { agentDisplayName } from '@workspace/core/agent-display';
import { isAppToolVisible, provideAppToolPresentation } from '../tool-presentation';

const props = withDefaults(defineProps<{
  agents?: readonly Agent[];
  tree: AgentSubagentTree;
  conversationId: string;
  visible?: boolean;
  loadMessages: (conversationId: string) => Promise<RendererMessage[]>;
}>(), {
  visible: true,
});

const emit = defineEmits<{
  'open-link': [link: ConversationLink];
}>();

const { t } = useI18n();
provideAppToolPresentation(
  (key, params) => t(key, params ?? {}),
  (identifier) => {
    const agent = props.agents?.find((candidate) => candidate.id === identifier);
    return agent ? agentDisplayName(agent) : undefined;
  },
);

const messages = ref<RendererMessage[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
let requestId = 0;
let pollTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
const pollIntervalMs = 1_500;

const node = computed(() => props.tree.nodes[props.conversationId] ?? null);
const childWorking = computed(() => node.value?.status === 'pendingInit' || node.value?.status === 'running');
const refreshKey = computed(() => `${props.conversationId}:${node.value?.updatedAt ?? ''}`);

watch(
  () => [refreshKey.value, props.visible !== false] as const,
  ([, visible]) => {
    requestId++;
    cancelPoll();
    if (visible) void refreshMessages();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  requestId++;
  cancelPoll();
});

async function refreshMessages(showLoading = true): Promise<void> {
  cancelPoll();
  const currentRequest = requestId + 1;
  requestId = currentRequest;
  loading.value = showLoading && messages.value.length === 0;
  if (showLoading) error.value = null;
  try {
    const nextMessages = await props.loadMessages(props.conversationId);
    if (requestId === currentRequest) {
      messages.value = nextMessages;
      error.value = null;
    }
  } catch (caught) {
    if (requestId === currentRequest && (showLoading || messages.value.length === 0)) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    }
  } finally {
    if (requestId === currentRequest) {
      loading.value = false;
      schedulePoll();
    }
  }
}

function schedulePoll(): void {
  if (props.visible === false || !childWorking.value) return;
  pollTimer = globalThis.setTimeout(() => {
    pollTimer = null;
    void refreshMessages(false);
  }, pollIntervalMs);
}

function cancelPoll(): void {
  if (pollTimer) globalThis.clearTimeout(pollTimer);
  pollTimer = null;
}

</script>

<style scoped>
.subagent-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  background: var(--color-shell-main);
}

.subagent-panel__conversation {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.subagent-panel__conversation :deep(.agent-ui-message-list) {
  min-height: 0;
  flex: 1 1 auto;
}

.subagent-panel__state {
  padding: var(--space-8);
  color: var(--color-text-muted);
  font-size: var(--font-size-13);
  text-align: center;
}

.subagent-panel__state--error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  color: var(--color-error);
}
</style>
