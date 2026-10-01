import { Menu } from 'lucide-react';
import { createContext, useContext } from 'react';
import { IconBtn } from '@/components/signal';

/** Opens the sidebar drawer on narrow screens. */
export const NavContext = createContext<() => void>(() => {});

export function MenuButton() {
	const openNav = useContext(NavContext);
	return <IconBtn icon={Menu} size="sm" label="Open sidebar" className="md:hidden" onClick={openNav} />;
}
