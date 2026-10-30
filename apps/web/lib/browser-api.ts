import { ApiClient } from '@montra/api-client';

/** API client for client components: goes through the same-origin BFF proxy at /api (cookie auth). */
export const browserApi = new ApiClient({ baseUrl: '/api' });
