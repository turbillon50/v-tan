const externalApi = import.meta.env.VITE_API_URL as string | undefined;

export const BASE_URL = externalApi
  ? externalApi.replace(/\/$/, "") + "/"
  : (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "") + "/";
