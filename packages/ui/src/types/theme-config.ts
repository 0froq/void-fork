export type IconOption = string | { dark: string; light: string };

export type FooterLink = {
  link: string;
  text: string;
};

export type FooterColumn = {
  items: Array<FooterLink>;
  title: string;
};

export type FooterSocialLink = {
  icon: string;
  label?: string;
  link: string;
};

export type FooterConfig = {
  copyright?: string;
  message?: string;
  nav?: Array<FooterColumn>;
  social?: Array<FooterSocialLink>;
};

export type BannerConfig = {
  icon?: 'vite' | 'vitest' | 'rolldown' | 'oxc' | 'viteplus';
  id: string;
  target?: '_self' | '_blank';
  text: string;
  url: string;
};

export type HeroAction = {
  link?: string;
  text: string;
  theme?: 'brand' | 'alt';
};

export type HeroConfig = {
  actions?: Array<HeroAction>;
  image?: {
    alt?: string;
    src?: string;
  };
  tagline?: string;
  text?: string;
};

export type FeatureConfig = {
  details?: string;
  icon?: string;
  iconify?: string;
  title: string;
};
