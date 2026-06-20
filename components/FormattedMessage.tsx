import { Text, View } from 'react-native';

// The ONE place the assistant's output markup is turned into UI. Today it
// handles the small text vocabulary the persona prompt allows: **bold** and
// "- " bullet lists (amounts are just bolded). Everything the bot says routes
// through here, so formatting stays consistent and is easy to change later.
//
// Built for growth: when richer output arrives (e.g. charts), add a block type
// in parseBlocks() and a matching case in renderBlock() — nothing else in the
// app needs to change.

type Block = { type: 'paragraph'; text: string } | { type: 'bullets'; items: string[] };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let bullets: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') });
    para = [];
  };
  const flushBullets = () => {
    if (bullets.length) blocks.push({ type: 'bullets', items: bullets });
    bullets = [];
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      bullets.push(bullet[1]);
    } else if (line.trim() === '') {
      flushPara();
      flushBullets();
    } else {
      flushBullets();
      para.push(line);
    }
  }
  flushPara();
  flushBullets();
  return blocks;
}

// Inline **bold** → styled <Text> segments. Odd-indexed splits are the bold runs.
function renderInline(text: string) {
  return text.split('**').map((part, i) =>
    i % 2 === 1 ? (
      <Text key={i} style={{ fontWeight: '700' }}>
        {part}
      </Text>
    ) : (
      <Text key={i}>{part}</Text>
    ),
  );
}

function renderBlock(block: Block, color: string, key: number) {
  const topGap = key === 0 ? 0 : 6;
  switch (block.type) {
    case 'bullets':
      return (
        <View key={key} style={{ marginTop: topGap }}>
          {block.items.map((item, j) => (
            <View key={j} style={{ flexDirection: 'row' }}>
              <Text style={{ color }}>• </Text>
              <Text style={{ color, flex: 1 }}>{renderInline(item)}</Text>
            </View>
          ))}
        </View>
      );
    case 'paragraph':
    default:
      return (
        <Text key={key} style={{ color, marginTop: topGap }}>
          {renderInline(block.text)}
        </Text>
      );
  }
}

export function FormattedMessage({ text, color }: { text: string; color: string }) {
  return <View>{parseBlocks(text).map((block, i) => renderBlock(block, color, i))}</View>;
}
