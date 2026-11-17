import { Menu } from '@/lib/icons';
import { createContext, useContext } from 'react';
import { IconBtn } from '@/components/kit/signal';

export const NavContext = createContext<() => void>(() => {});

export function MenuButton() {
	const openNav = useContext(NavContext);
	return <IconBtn icon={Menu} size="sm" label="Open sidebar" className="md:hidden" onClick={openNav} />;
}
