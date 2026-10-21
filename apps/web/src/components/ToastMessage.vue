<script setup lang="ts">
import { useAccount } from "../stores/account";

const a = useAccount();
</script>

<template>
  <div v-if="a.toast" :key="a.toast.id" class="toast" :class="a.toast.kind" role="status" aria-live="polite">{{ a.toast.text }}</div>
</template>
