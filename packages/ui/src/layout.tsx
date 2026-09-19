import type { ComponentProps, ReactNode } from 'react';
import { cn } from './shadcn/utils.js';

/**
 * The frame every destination sits in.
 *
 * Each page had grown its own width and its own gutters - 1480px here,
 * 1180px there, 980px on one, 760px inside another - so moving between them
 * shifted the content sideways under the cursor and nothing lined up with the
 * header above it. There is now one container, and a page that wants to be
 * narrower says so inside it rather than by moving it.
 */

export interface PageContainerProps extends ComponentProps<'div'> {
  /**
   * Content that reads badly at full width - a single column of form fields -
   * can narrow itself. The gutters do not change, so the page edge does not move.
   */
  readonly width?: 'default' | 'narrow';
}

export function PageContainer({ width = 'default', className, ...props }: PageContainerProps) {
  return (
    <div
      data-slot="page-container"
      className={cn(
        'mx-auto flex w-full min-w-0 flex-col gap-(--section-gap)',
        'px-(--page-gutter) pt-(--page-gutter)',
        // Clear the mobile tab bar and the home indicator below it. On desktop
        // the bar is gone and only ordinary breathing room is left.
        'pb-[calc(var(--page-gutter)+4.25rem+env(safe-area-inset-bottom))] md:pb-12',
        width === 'narrow' ? 'max-w-3xl' : 'max-w-(--page-width)',
        className,
      )}
      {...props}
    />
  );
}

export interface PageHeaderProps extends Omit<ComponentProps<'div'>, 'title'> {
  readonly title: ReactNode;
  /** One short line. Leave it out when the title already says it. */
  readonly description?: ReactNode;
  /** The primary action for the whole page, if it has one. */
  readonly actions?: ReactNode;
}

export function PageHeader({ title, description, actions, className, ...props }: PageHeaderProps) {
  return (
    <div
      data-slot="page-header"
      className={cn('flex flex-wrap items-end justify-between gap-3', className)}
      {...props}
    >
      <div className="grid min-w-0 gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export interface SectionProps extends Omit<ComponentProps<'section'>, 'title'> {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}

/** A labelled group of related things. The heading level stays below the page title. */
export function Section({ title, description, actions, children, className, ...props }: SectionProps) {
  return (
    <section
      data-slot="section"
      className={cn('grid min-w-0 gap-3', className)}
      {...props}
    >
      {title || actions ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="grid min-w-0 gap-0.5">
            {title ? <h2 className="text-base font-semibold tracking-tight">{title}</h2> : null}
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export interface CardGridProps extends ComponentProps<'div'> {
  /** Columns at the widest breakpoint. Always one column on a phone. */
  readonly columns?: 2 | 3;
}

const gridColumns = {
  2: 'lg:grid-cols-2',
  3: 'md:grid-cols-2 xl:grid-cols-3',
} as const;

/**
 * Cards of equal width that do not drag each other's height around.
 *
 * `items-start` is the point: without it every card in a row stretched to the
 * tallest one, which is how the console ended up with a card holding a select
 * at the top, a gap of empty space, and its buttons pinned to the bottom.
 */
export function CardGrid({ columns = 3, className, ...props }: CardGridProps) {
  return (
    <div
      data-slot="card-grid"
      className={cn('grid min-w-0 items-start gap-(--section-gap)', gridColumns[columns], className)}
      {...props}
    />
  );
}

/**
 * A labelled value in a card: the name on one side, the value on the other.
 *
 * Rows like this had been rebuilt in five places with five different paddings
 * and, in one of them, without the `min-w-0` that stops a long value pushing
 * its own button out through the side of the card.
 */
export function DetailRow({
  label,
  hint,
  children,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <div
      data-slot="detail-row"
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t py-3 first:border-t-0 first:pt-0 last:pb-0',
        className,
      )}
      {...props}
    >
      {/* `flex-1` and a `minmax(0, 1fr)` track, not only `min-w-0`: an auto
          grid track is sized by its content, so one long value - a file path,
          a bucket name - widened the row until the card scrolled sideways
          rather than being clipped where it asked to be.

          `basis-44` is what makes the wrap in `flex-wrap` above actually
          happen. With `min-w-0` alone the label had no width it would not give
          up, so a row whose buttons were wide squeezed the name into a column
          one word across - "Lần gửi gần nhất" stacked four lines high beside
          them. Below eleven rem the buttons go to a line of their own instead. */}
      <div className="grid min-w-0 flex-1 basis-44 grid-cols-[minmax(0,1fr)] gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      <div className="flex min-w-0 shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
