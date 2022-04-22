#include <SKELETON.hpp>

SKELETON::SKELETON() 
{ 
    this->Type = "SKELETON";
}

SKELETON::SKELETON(nlohmann::json config)
{
    this->Type = "SKELETON";
}

nlohmann::json SKELETON::Export()
{
    nlohmann::json config;
    return config;
}

extern "C"
{
    ecs::Component *create_component(void *p)
    {
        if(p == nullptr)
        {
            return new SKELETON();
        }

        nlohmann::json *config = (nlohmann::json *)p;
        return new SKELETON(*config);
    }
}
