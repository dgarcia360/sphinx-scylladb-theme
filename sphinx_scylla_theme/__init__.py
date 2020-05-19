from os import path
from .extensions import panel_box, topic_box

def setup(app):
    """Setup theme and custom extensions."""
    app.add_html_theme('sphinx_scylla_theme', path.abspath(path.dirname(__file__)))

    panel_box.setup(app)
    topic_box.setup(app)

__version__ = '0.1.1'
