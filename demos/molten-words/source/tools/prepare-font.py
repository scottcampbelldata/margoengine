# Build the exhibit's uppercase subset from the pinned Adobe Source Sans 3 font.
from pathlib import Path
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


def build(source, destination):
    font = instantiateVariableFont(TTFont(source), {"wght": 900}, inplace=True)
    settings = subset.Options()
    settings.name_IDs += [16, 17, 21, 22, 25]
    subsetter = subset.Subsetter(settings)
    subsetter.populate(text=" ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")
    subsetter.subset(font)
    names = {
        1: "Foundry Sans",
        2: "Black",
        3: "Foundry Sans Black 1.0",
        4: "Foundry Sans Black",
        6: "FoundrySans-Black",
        16: "Foundry Sans",
        17: "Black",
        21: "Foundry Sans",
        22: "Black",
        25: "FoundrySans",
    }
    for record in font["name"].names:
        if record.nameID in names:
            record.string = names[record.nameID]
    font.save(destination)


if __name__ == "__main__":
    build(Path(sys.argv[1]), Path(sys.argv[2]))
