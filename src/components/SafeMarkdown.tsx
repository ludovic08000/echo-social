/**
 * SafeMarkdown — Restricted ReactMarkdown wrapper
 * Only allows safe inline/block elements, strips HTML tags, links open in new tab with noopener.
 */
import ReactMarkdown from 'react-markdown';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

const ALLOWED_ELEMENTS = [
  'p', 'br', 'strong', 'em', 'b', 'i', 'u',
  'h1', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li',
  'code', 'pre',
  'blockquote',
  'a',
  'hr',
];

interface SafeMarkdownProps {
  children: string;
  className?: string;
}

export function SafeMarkdown({ children, className }: SafeMarkdownProps) {
  return (
    <div className={className}>
    <ReactMarkdown
      allowedElements={ALLOWED_ELEMENTS}
      skipHtml
      components={{
        a: ({ href, children: kids }) => (
          <a
            href={sanitizeUrl(href)}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-primary underline"
          >
            {kids}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
