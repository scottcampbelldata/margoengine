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
        rule = {'target': target, 'event': t['event']}
        if t.get('active'):
            rule['guard'] = "active('%s')" % t['active']
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
        interpreter.queue(step)
        interpreter.execute()
        trace.append(atoms(interpreter, statechart))
    return trace


print(json.dumps([run(chart) for chart in json.load(sys.stdin)]))
