// The Conversation composer's "/" picker: the session's skills and custom
// slash commands (GET /api/sessions/:id/skills), filtered as you type the
// name. Picking one only fills in "/name " — sending is still the composer's
// job, and anything typed after a slash (built-ins like /compact included)
// sends as-is whether or not it is listed here.
import { useEffect, useRef } from 'react';
import type { SkillEntry } from '../../sessions/skill-catalog.js';

const SOURCE_LABEL: Record<SkillEntry['source'], string> = { project: 'Project', user: 'Personal', plugin: 'Plugin' };

/** The name being typed when the draft is a bare "/word", or undefined when the picker shouldn't show. */
export function slashQuery(draft: string): string | undefined {
  return /^\/(\S*)$/.exec(draft)?.[1];
}

/** Names that start with the query (or whose part after a `ns:` does) first, then any other name or description match. */
export function filterSkills(skills: readonly SkillEntry[], query: string): SkillEntry[] {
  const needle = query.toLowerCase();
  if (!needle) return [...skills];
  const starts = (skill: SkillEntry) => skill.name.toLowerCase().split(':').some((_, index, parts) => parts.slice(index).join(':').startsWith(needle));
  const prefix = skills.filter(starts);
  const rest = skills.filter((skill) => !starts(skill)
    && `${skill.name} ${skill.description}`.toLowerCase().includes(needle));
  return [...prefix, ...rest];
}

export function slashOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

export function SlashMenu({ id, items, loading, activeIndex, onHover, onPick }: {
  id: string;
  items: readonly SkillEntry[];
  loading: boolean;
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (skill: SkillEntry) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="slash-menu">
      <div aria-label="Skills and commands" className="slash-menu-list" id={id} ref={listRef} role="listbox">
        {items.map((skill, index) => (
          <div
            aria-selected={index === activeIndex}
            className={index === activeIndex ? 'slash-menu-item is-selected' : 'slash-menu-item'}
            id={slashOptionId(id, index)}
            key={skill.name}
            // Keep focus in the textarea: pick on mousedown, before it blurs.
            onMouseDown={(event) => { event.preventDefault(); onPick(skill); }}
            onMouseEnter={() => onHover(index)}
            role="option"
          >
            <strong>/{skill.name}</strong>
            {skill.description && <span className="slash-menu-description">{skill.description}</span>}
            <em>{SOURCE_LABEL[skill.source]}</em>
          </div>
        ))}
        {items.length === 0 && (
          <div className="slash-menu-empty">{loading ? 'Loading skills…' : 'No matching skills — Enter sends it as typed.'}</div>
        )}
      </div>
      <footer><span>↑↓ Navigate</span><span>↵ or Tab Select</span><span>Esc Close</span></footer>
    </div>
  );
}
