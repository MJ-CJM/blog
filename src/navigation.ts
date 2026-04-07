import { getPermalink, getBlogPermalink, getAsset } from './utils/permalinks';

export const headerData = {
  links: [
    {
      text: '博客',
      href: getBlogPermalink(),
    },
    {
      text: '归档',
      href: getPermalink('/archives'),
    },
    {
      text: '标签',
      href: getPermalink('/tags'),
    },
    {
      text: '友链',
      href: getPermalink('/links'),
    },
    {
      text: '关于',
      href: getPermalink('/about'),
    },
  ],
  actions: [],
};

export const footerData = {
  links: [],
  secondaryLinks: [
    { text: '旧博客', href: 'https://blog.mj-cjm.top' },
  ],
  socialLinks: [
    { ariaLabel: 'GitHub', icon: 'tabler:brand-github', href: 'https://github.com/MJ-CJM' },
    { ariaLabel: 'RSS', icon: 'tabler:rss', href: getAsset('/rss.xml') },
  ],
  footNote: `© 2026 MJ-CJM Blog. All rights reserved.`,
};
