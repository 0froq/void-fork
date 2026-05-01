export interface Sponsor {
  hasDark?: true;
  img: string;
  name: string;
  url: string;
}

export type SponsorSize = 'big' | 'medium' | 'small' | 'avatar';

export interface SponsorTier {
  items: Array<Sponsor>;
  size: SponsorSize;
  tier: string;
}
