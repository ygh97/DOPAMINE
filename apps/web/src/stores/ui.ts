import { defineStore } from "pinia";
import { ref, watch } from "vue";

const THEME_KEY = "dc-theme";
const readTheme = (): "light" | "dark" => {
  try { return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; } catch { return "light"; }
};

export const useUi = defineStore("ui", () => {
  const theme = ref(readTheme());
  watch(theme, t => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch { /* 저장 불가 환경은 무시 */ }
  }, { immediate: true });
  const toggleTheme = () => { theme.value = theme.value === "dark" ? "light" : "dark"; };
  return { theme, toggleTheme };
});
