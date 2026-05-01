export type IconOption = string | { dark: string; light: string };

export interface FooterLink {
  link: string;
  text: string;
}

export interface FooterColumn {
  items: Array<FooterLink>;
  title: string;
}

export interface FooterSocialLink {
  icon: string;
  label?: string;
  link: string;
}

export interface FooterConfig {
  copyright?: string;
  message?: string;
  nav?: Array<FooterColumn>;
  social?: Array<FooterSocialLink>;
}

export interface BannerConfig {
  icon?: 'vite' | 'vitest' | 'rolldown' | 'oxc' | 'viteplus';
  id: string;
  target?: '_self' | '_blank';
  text: string;
  url: string;
}

export interface HeroAction {
  link?: string;
  text: string;
  theme?: 'brand' | 'alt';
}

export interface HeroConfig {
  actions?: Array<HeroAction>;
  image?: {
    alt?: string;
    src?: string;
  };
  tagline?: string;
  text?: string;
}

export interface FeatureConfig {
  details?: string;
  icon?: string;
  iconify?: string;
  title: string;
}
