# Runs charts through Sismic, an outside statechart interpreter, used as a tool only through its documented API.
# Reads the charts from stdin as JSON and prints the active atomic states after the start and after every step.
import json
import sys

from sismic.interpreter import Interpreter
from sismic.io import import_from_yaml


def remembered(node, names):
    if node.get('history'):
        names.add(node['name'])
    for child in node['children']:
        remembered(child, names)
    return names


# A Margo state with history is entered through a history state of Sismic.
def state(node, memory):
    out = {'name': node['name']}
    transitions = []
    for t in node['transitions']:
        target = t['to'] + '_h' if t['to'] in memory else t['to']
        rule = {'target': target}
        tests = []
        if 'after' in t:
            tests.append('after(%d)' % t['after'])
        else:
            rule['event'] = t['event']
        if t.get('active'):
            tests.append("active('%s')" % t['active'])
        if tests:
            rule['guard'] = ' and '.join(tests)
        transitions.append(rule)
    if transitions:
        out['transitions'] = transitions
    if node['children']:
        kids = [state(child, memory) for child in node['children']]
        if node.get('history'):
            kids.append({
                'name': node['name'] + '_h',
                'type': node['history'] + ' history',
                'memory': node['initial'],
            })
        if node.get('parallel'):
            out['parallel states'] = kids
        else:
            out['states'] = kids
            out['initial'] = node['initial']
    return out


def atoms(interpreter, statechart):
    leaves = [n for n in interpreter.configuration if not statechart.children_for(n)]
    return ' '.join(sorted(leaves))


def run(chart):
    # JSON is YAML, so the chart needs no YAML writer.
    text = json.dumps({'statechart': {'name': 'chart', 'root state': state(chart['root'], remembered(chart['root'], set()))}})
    statechart = import_from_yaml(text=text)
    interpreter = Interpreter(statechart)
    interpreter.execute()
    trace = [atoms(interpreter, statechart)]
    for step in chart['script']:
        if step == 'tick':
            interpreter.clock.time += 1
        else:
            interpreter.queue(step)
        interpreter.execute()
        trace.append(atoms(interpreter, statechart))
    return trace


print(json.dumps([run(chart) for chart in json.load(sys.stdin)]))
