import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Its own module, so the launcher reads them without loading the Settings pages. */
export const useGeneralSettings = () => useQuery({ queryKey: ['general-settings'], queryFn: api.generalSettings });
