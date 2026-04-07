import { getPermalink, getBlogPermalink, getAsset } from './utils/permalinks';

export const headerData = {
  links: [
    {
      text: '博客',
      href: getBlogPermalink(),
    },
    {
      text: '关于',
      href: getPermalink('/about'),
    },
    {
      text: '旧博客',
      href: 'https://mj-cjm.github.io',
    },
  ],
  actions: [],
};

export const footerData = {
  links: [],
  secondaryLinks: [],
  socialLinks: [
    { ariaLabel: 'GitHub', icon: 'tabler:brand-github', href: 'https://github.com/MJ-CJM' },
    { ariaLabel: 'RSS', icon: 'tabler:rss', href: getAsset('/rss.xml') },
  ],
  footNote: `© 2026 MJ-CJM Blog. All rights reserved.`,
};
