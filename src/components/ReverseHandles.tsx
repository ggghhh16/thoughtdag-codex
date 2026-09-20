import { Handle, Position } from '@xyflow/react';

/** Hidden opposite-direction ports preserve endpoints when reversing a wire. */
export function ReverseHandles({ glyph = false, material = false, large = false }: { glyph?: boolean; material?: boolean; large?: boolean }) {
  const invisible = '!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none';
  // React Flow attaches to the outer edge of the handle, not its center.
  // Match the visible port's dimensions so reversal does not shift the wire.
  const vertical = `!opacity-0 !pointer-events-none !border-0 ${large ? '!w-6 !h-6' : '!w-3.5 !h-3.5'}`;
  const left = glyph ? { top: '50%', left: 'calc(50% - 56px)' } : { top: '40%' };
  const right = glyph ? { top: '50%', left: 'calc(50% + 56px)', right: 'auto' } : { top: '50%' };
  return <>
    <Handle id="reverse-top" type="source" position={Position.Top} isConnectable={false} className={vertical} />
    <Handle id="reverse-bottom" type="target" position={Position.Bottom} isConnectable={false} className={vertical} />
    <Handle id="reverse-left" type="source" position={Position.Left} isConnectable={false} className={invisible} style={left} />
    <Handle id="reverse-right" type="target" position={Position.Right} isConnectable={false} className={invisible} style={right} />
    {material && <>
      <Handle id="top" type="target" position={Position.Top} isConnectable={false} className={vertical} />
      <Handle id="left" type="target" position={Position.Left} isConnectable={false} className={invisible} style={left} />
    </>}
  </>;
}
