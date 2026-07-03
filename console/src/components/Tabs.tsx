export interface Tab<Id extends string> {
  id: Id;
  label: string;
}

export interface TabsProps<Id extends string> {
  tabs: Tab<Id>[];
  active: Id;
  onChange: (id: Id) => void;
}

export function Tabs<Id extends string>({ tabs, active, onChange }: TabsProps<Id>) {
  return (
    <div className="tabs adminbar" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === active}
          className={t.id === active ? "navlink on" : "navlink"}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
