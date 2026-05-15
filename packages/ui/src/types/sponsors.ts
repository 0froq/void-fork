export type Sponsor = {
  hasDark?: true;
  img: string;
  name: string;
  url: string;
};

export type SponsorSize = 'big' | 'medium' | 'small' | 'avatar';

export type SponsorTier = {
  items: Array<Sponsor>;
  size: SponsorSize;
  tier: string;
};
